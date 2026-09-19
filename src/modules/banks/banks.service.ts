import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

export const banksService = {
  async list(tenantId: string) {
    return prisma.bank.findMany({
      where: { tenantId, deletedAt: null },
      include: { _count: { select: { accounts: true } } },
      orderBy: { name: "asc" },
    });
  },

  async getById(tenantId: string, id: string) {
    const bank = await prisma.bank.findFirst({ where: { id, tenantId, deletedAt: null }, include: { accounts: true } });
    if (!bank) throw new NotFoundError("Bank not found");
    return bank;
  },

  async create(tenantId: string, input: { name: string; swiftCode?: string; country?: string }, actorId: string) {
    const bank = await prisma.bank.create({ data: { ...input, tenantId } });
    await auditService.record({ tenantId, actorId, action: "bank.create", entityType: "Bank", entityId: bank.id, afterState: bank });
    return bank;
  },

  async update(tenantId: string, id: string, input: { name?: string; swiftCode?: string; country?: string; status?: string }, actorId: string) {
    const before = await prisma.bank.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!before) throw new NotFoundError("Bank not found");
    const bank = await prisma.bank.update({ where: { id }, data: input as any });
    await auditService.record({ tenantId, actorId, action: "bank.update", entityType: "Bank", entityId: id, beforeState: before, afterState: bank });
    return bank;
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const bank = await prisma.bank.findFirst({ where: { id, tenantId, deletedAt: null }, include: { _count: { select: { accounts: true } } } });
    if (!bank) throw new NotFoundError("Bank not found");
    if (bank._count.accounts > 0) throw new ConflictError("Bank has linked accounts and cannot be deleted");
    await prisma.bank.update({ where: { id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
    await auditService.record({ tenantId, actorId, action: "bank.delete", entityType: "Bank", entityId: id, beforeState: bank });
    return { deleted: true };
  },
};
