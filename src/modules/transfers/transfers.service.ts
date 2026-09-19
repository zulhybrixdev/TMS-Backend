import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { generateDocumentNumber } from "../../common/id-generator";
import { approvalsService } from "../approvals/approvals.service";
import { getActiveAccountsWithBank, toAccountLike } from "../bank-accounts/bank-accounts.service";
import { recommendTransfers, validateTransferAmount } from "../../treasury-engine/cash-engine.service";
import { cashPositionService } from "../cash-position/cash-position.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";

const include = {
  sourceAccount: { include: { bank: true } },
  destinationAccount: { include: { bank: true } },
  currency: true,
  requestedBy: { select: { id: true, name: true, email: true } },
  approvalRequests: { include: { actions: { include: { actor: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "desc" as const } },
};

function serialize(row: any) {
  return {
    id: row.id,
    transferNumber: row.transferNumber,
    sourceAccountId: row.sourceAccountId,
    sourceAccountName: row.sourceAccount?.accountName,
    sourceBankName: row.sourceAccount?.bank?.name,
    destinationAccountId: row.destinationAccountId,
    destinationAccountName: row.destinationAccount?.accountName,
    destinationBankName: row.destinationAccount?.bank?.name,
    amount: Number(row.amount),
    suggestedAmount: row.suggestedAmount ? Number(row.suggestedAmount) : null,
    currencyCode: row.currencyCode,
    reason: row.reason,
    transferDate: row.transferDate,
    status: row.status,
    isSystemRecommended: row.isSystemRecommended,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvalRequests: row.approvalRequests,
  };
}

export const transfersService = {
  // Ranked, editable suggestions for moving cash from accounts with excess
  // into accounts in shortfall - the core "recommend a transfer" flow.
  async getRecommendations(tenantId: string) {
    const accounts = await getActiveAccountsWithBank(tenantId);
    const config = await cashPositionService.getEngineConfig(tenantId);
    return recommendTransfers(accounts.map(toAccountLike), config);
  },

  async list(tenantId: string, query: ParsedListQuery, filters: { status?: string; sourceAccountId?: string; destinationAccountId?: string }) {
    const where: any = { tenantId };
    if (filters.status) where.status = filters.status;
    if (filters.sourceAccountId) where.sourceAccountId = filters.sourceAccountId;
    if (filters.destinationAccountId) where.destinationAccountId = filters.destinationAccountId;
    if (query.search) where.transferNumber = { contains: query.search };

    const [rows, total] = await Promise.all([
      prisma.transfer.findMany({ where, include, skip: query.skip, take: query.take, orderBy: { [query.sortBy ?? "createdAt"]: query.sortDir } }),
      prisma.transfer.count({ where }),
    ]);
    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const row = await prisma.transfer.findFirst({ where: { id, tenantId }, include });
    if (!row) throw new NotFoundError("Transfer not found");
    return serialize(row);
  },

  async create(tenantId: string, input: any, actorId: string) {
    if (input.sourceAccountId === input.destinationAccountId) {
      throw new BadRequestError("Source and destination accounts must be different");
    }
    const [source, destination] = await Promise.all([
      prisma.bankAccount.findFirst({ where: { id: input.sourceAccountId, tenantId, deletedAt: null } }),
      prisma.bankAccount.findFirst({ where: { id: input.destinationAccountId, tenantId, deletedAt: null } }),
    ]);
    if (!source) throw new NotFoundError("Source account not found");
    if (!destination) throw new NotFoundError("Destination account not found");

    // Prevent transfers that would push the source account below its own
    // minimum balance (business rule from the cash engine).
    const check = validateTransferAmount(
      { currentBalance: Number(source.currentBalance), reservedAmount: Number(source.reservedAmount), minimumBalance: Number(source.minimumBalance) },
      input.amount
    );
    if (!check.valid) throw new BadRequestError(check.reason, { maxAllowed: check.maxAllowed });

    const transferNumber = await generateDocumentNumber(tenantId, "TRF");
    const row = await prisma.transfer.create({
      data: { ...input, tenantId, transferNumber, transferDate: new Date(input.transferDate), status: "DRAFT", requestedById: actorId },
      include,
    });
    await auditService.record({ tenantId, actorId, action: "transfer.create", entityType: "Transfer", entityId: row.id, afterState: serialize(row) });
    return serialize(row);
  },

  async submit(tenantId: string, id: string, actorId: string) {
    const transfer = await prisma.$transaction(async (tx) => {
      const before = await tx.transfer.findFirst({ where: { id, tenantId } });
      if (!before) throw new NotFoundError("Transfer not found");
      if (before.status !== "DRAFT") throw new ConflictError("Only draft transfers can be submitted for approval");

      const updated = await tx.transfer.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
      await approvalsService.createForEntity(tx, {
        tenantId,
        entityType: "TRANSFER",
        transferId: id,
        requestedById: actorId,
        amount: Number(updated.amount),
        currencyCode: updated.currencyCode,
      });
      return updated;
    });

    await auditService.record({ tenantId, actorId, action: "transfer.submit", entityType: "Transfer", entityId: id, afterState: { status: "PENDING_APPROVAL" } });
    return this.getById(tenantId, transfer.id);
  },

  async cancel(tenantId: string, id: string, actorId: string) {
    const transfer = await prisma.transfer.findFirst({ where: { id, tenantId } });
    if (!transfer) throw new NotFoundError("Transfer not found");
    if (!["DRAFT", "PENDING_APPROVAL"].includes(transfer.status)) {
      throw new BadRequestError("Only draft or pending transfers can be cancelled");
    }

    await prisma.$transaction(async (tx) => {
      await tx.transfer.update({ where: { id }, data: { status: "CANCELLED" } });
      await tx.approvalRequest.updateMany({ where: { transferId: id, status: "PENDING" }, data: { status: "CANCELLED" } });
    });

    await auditService.record({ tenantId, actorId, action: "transfer.cancel", entityType: "Transfer", entityId: id });
    return this.getById(tenantId, id);
  },
};
