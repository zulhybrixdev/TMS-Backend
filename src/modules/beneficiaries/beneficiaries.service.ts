import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

interface BeneficiaryInput {
  nickname: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  currencyCode?: string;
}

export const beneficiariesService = {
  async list(tenantId: string, search?: string) {
    return prisma.beneficiary.findMany({
      where: {
        tenantId,
        isActive: true,
        ...(search
          ? { OR: [{ nickname: { contains: search } }, { accountName: { contains: search } }, { accountNumber: { contains: search } }] }
          : {}),
      },
      orderBy: { nickname: "asc" },
    });
  },

  async getById(tenantId: string, id: string) {
    const beneficiary = await prisma.beneficiary.findFirst({ where: { id, tenantId } });
    if (!beneficiary) throw new NotFoundError("Beneficiary not found");
    return beneficiary;
  },

  async create(tenantId: string, input: BeneficiaryInput, actorId: string) {
    const existing = await prisma.beneficiary.findFirst({ where: { tenantId, accountNumber: input.accountNumber, bankName: input.bankName } });
    if (existing) throw new ConflictError("A beneficiary with this account number and bank already exists");

    const beneficiary = await prisma.beneficiary.create({ data: { ...input, tenantId } });
    await auditService.record({ tenantId, actorId, action: "beneficiary.create", entityType: "Beneficiary", entityId: beneficiary.id, afterState: beneficiary });
    return beneficiary;
  },

  async update(tenantId: string, id: string, input: Partial<BeneficiaryInput> & { isActive?: boolean }, actorId: string) {
    const before = await prisma.beneficiary.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Beneficiary not found");

    const beneficiary = await prisma.beneficiary.update({ where: { id }, data: input });
    await auditService.record({ tenantId, actorId, action: "beneficiary.update", entityType: "Beneficiary", entityId: id, beforeState: before, afterState: beneficiary });
    return beneficiary;
  },

  // Soft-remove only (isActive: false) - a Payment never holds a foreign
  // key to Beneficiary (it snapshots the fields), so this can never fail
  // with a "linked records" conflict the way banks.service's delete can.
  async remove(tenantId: string, id: string, actorId: string) {
    const before = await prisma.beneficiary.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Beneficiary not found");

    await prisma.beneficiary.update({ where: { id }, data: { isActive: false } });
    await auditService.record({ tenantId, actorId, action: "beneficiary.delete", entityType: "Beneficiary", entityId: id, beforeState: before });
    return { deleted: true };
  },
};
