import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

// Currencies are global ISO reference data shared by every tenant (see
// schema.prisma). Only the audit trail entry is tenant-scoped, so a change
// still shows up in the acting tenant's own audit log.
export const currenciesService = {
  async list() {
    return prisma.currency.findMany({ orderBy: { code: "asc" } });
  },

  async create(tenantId: string, input: { code: string; name: string; symbol: string; isBase?: boolean }, actorId: string) {
    const existing = await prisma.currency.findUnique({ where: { code: input.code } });
    if (existing) throw new ConflictError("Currency already exists");
    const currency = await prisma.currency.create({ data: { ...input, code: input.code.toUpperCase() } });
    await auditService.record({ tenantId, actorId, action: "currency.create", entityType: "Currency", entityId: currency.code, afterState: currency });
    return currency;
  },

  async update(tenantId: string, code: string, input: { name?: string; symbol?: string; isActive?: boolean; isBase?: boolean }, actorId: string) {
    const before = await prisma.currency.findUnique({ where: { code } });
    if (!before) throw new NotFoundError("Currency not found");
    const currency = await prisma.currency.update({ where: { code }, data: input });
    await auditService.record({ tenantId, actorId, action: "currency.update", entityType: "Currency", entityId: code, beforeState: before, afterState: currency });
    return currency;
  },
};
