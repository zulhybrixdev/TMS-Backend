import { prisma } from "../../common/prisma";
import { NotFoundError, BadRequestError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { toCsv, CsvColumn } from "../../common/csv";
import { toXlsxBuffer } from "../../common/xlsx";
import { BASE_REPORTS } from "../reports/reports.service";

function serialize(def: any) {
  return {
    id: def.id,
    name: def.name,
    baseReport: def.baseReport,
    baseReportLabel: BASE_REPORTS[def.baseReport]?.label ?? def.baseReport,
    columns: def.columns as string[],
    createdBy: def.createdBy,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

function validateColumns(baseReport: string, columns: string[]) {
  const base = BASE_REPORTS[baseReport];
  if (!base) throw new BadRequestError(`Unknown base report: ${baseReport}`);
  const available = new Set(base.columns.map((c) => c.header));
  const invalid = columns.filter((c) => !available.has(c));
  if (invalid.length > 0) throw new BadRequestError(`Not valid columns for ${baseReport}: ${invalid.join(", ")}`);
}

export const reportDefinitionsService = {
  availableReports() {
    return Object.entries(BASE_REPORTS).map(([key, r]) => ({ key, label: r.label, columns: r.columns.map((c) => c.header) }));
  },

  async list(tenantId: string) {
    const rows = await prisma.reportDefinition.findMany({
      where: { tenantId },
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serialize);
  },

  async create(tenantId: string, actorId: string, input: { name: string; baseReport: string; columns: string[] }) {
    validateColumns(input.baseReport, input.columns);
    const def = await prisma.reportDefinition.create({
      data: { tenantId, name: input.name, baseReport: input.baseReport, columns: input.columns, createdById: actorId },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    await auditService.record({ tenantId, actorId, action: "report_definition.create", entityType: "ReportDefinition", entityId: def.id, afterState: serialize(def) });
    return serialize(def);
  },

  async remove(tenantId: string, actorId: string, id: string) {
    const def = await prisma.reportDefinition.findFirst({ where: { id, tenantId } });
    if (!def) throw new NotFoundError("Report definition not found");
    await prisma.reportDefinition.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "report_definition.delete", entityType: "ReportDefinition", entityId: id, beforeState: def });
    return { deleted: true };
  },

  // Runs a saved definition: fetches the base report's full dataset (same
  // fetch every built-in report uses, so tenant scoping/data access is
  // identical) and projects it down to just the definition's chosen
  // columns, in the order the definition stored them.
  async run(tenantId: string, id: string, opts: { from?: Date; to?: Date }): Promise<{ name: string; rows: any[]; columns: CsvColumn<any>[] }> {
    const def = await prisma.reportDefinition.findFirst({ where: { id, tenantId } });
    if (!def) throw new NotFoundError("Report definition not found");

    const base = BASE_REPORTS[def.baseReport];
    if (!base) throw new BadRequestError(`Unknown base report: ${def.baseReport}`);

    const rows = await base.fetch(tenantId, opts.from, opts.to);
    const selectedColumns = (def.columns as string[])
      .map((header) => base.columns.find((c) => c.header === header))
      .filter((c): c is CsvColumn<any> => !!c);

    return { name: def.name, rows, columns: selectedColumns };
  },

  async runAsJson(tenantId: string, id: string, opts: { from?: Date; to?: Date }) {
    const { rows, columns } = await this.run(tenantId, id, opts);
    return rows.map((row) => Object.fromEntries(columns.map((c) => [c.header, c.value(row)])));
  },

  async runAsCsv(tenantId: string, id: string, opts: { from?: Date; to?: Date }) {
    const { rows, columns } = await this.run(tenantId, id, opts);
    return toCsv(rows, columns);
  },

  async runAsXlsx(tenantId: string, id: string, opts: { from?: Date; to?: Date }) {
    const { name, rows, columns } = await this.run(tenantId, id, opts);
    return toXlsxBuffer(name, rows, columns);
  },
};
