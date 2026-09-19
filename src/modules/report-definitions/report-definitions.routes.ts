import { Router, Response } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { reportDefinitionsService } from "./report-definitions.service";
import { createReportDefinitionSchema } from "./report-definitions.schemas";
import { auditService } from "../../common/audit.service";

export const reportDefinitionsRouter = Router();
reportDefinitionsRouter.use(requirePermission(PERMISSIONS.REPORTS_VIEW, PERMISSIONS.REPORTS_EXPORT));
reportDefinitionsRouter.use(requireModule(MODULE_KEYS.ADVANCED_INSIGHTS));

function dateRange(req: any) {
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  return { from, to };
}

function sendXlsx(res: Response, filename: string, buffer: Buffer) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

reportDefinitionsRouter.get("/available-reports", asyncHandler(async (req, res) => ok(res, reportDefinitionsService.availableReports())));

reportDefinitionsRouter.get("/", asyncHandler(async (req, res) => ok(res, await reportDefinitionsService.list(req.user!.tenantId))));

reportDefinitionsRouter.post(
  "/",
  requirePermission(PERMISSIONS.REPORTS_EXPORT),
  validate(createReportDefinitionSchema),
  asyncHandler(async (req, res) => created(res, await reportDefinitionsService.create(req.user!.tenantId, req.user!.id, req.body)))
);

reportDefinitionsRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.REPORTS_EXPORT),
  asyncHandler(async (req, res) => ok(res, await reportDefinitionsService.remove(req.user!.tenantId, req.user!.id, req.params.id)))
);

reportDefinitionsRouter.get(
  "/:id/run",
  asyncHandler(async (req, res) => {
    const { from, to } = dateRange(req);
    if (req.query.format === "csv") {
      await auditService.record({ tenantId: req.user!.tenantId, actorId: req.user!.id, action: "report_definition.export.csv", entityType: "ReportDefinition", entityId: req.params.id });
      const csv = await reportDefinitionsService.runAsCsv(req.user!.tenantId, req.params.id, { from, to });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="custom-report.csv"`);
      return res.send(csv);
    }
    if (req.query.format === "xlsx") {
      await auditService.record({ tenantId: req.user!.tenantId, actorId: req.user!.id, action: "report_definition.export.xlsx", entityType: "ReportDefinition", entityId: req.params.id });
      const buffer = await reportDefinitionsService.runAsXlsx(req.user!.tenantId, req.params.id, { from, to });
      return sendXlsx(res, "custom-report.xlsx", buffer);
    }
    ok(res, await reportDefinitionsService.runAsJson(req.user!.tenantId, req.params.id, { from, to }));
  })
);
