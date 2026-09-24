import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { postLedgerEntry } from "../../treasury-engine/ledger.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";
import { addBusinessDays, toDateOnly, todayDateOnly } from "../../common/dates";

const include = { destinationAccount: { include: { bank: true } }, currency: true };

function serialize(row: any) {
  return {
    id: row.id,
    reference: row.reference,
    sourceName: row.sourceName,
    amount: Number(row.amount),
    currencyCode: row.currencyCode,
    destinationAccountId: row.destinationAccountId,
    destinationAccountName: row.destinationAccount?.accountName,
    destinationBankName: row.destinationAccount?.bank?.name,
    valueDate: row.valueDate,
    invoiceNumber: row.invoiceNumber,
    floatDays: row.floatDays,
    clearingDate: row.clearingDate,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// The ledger posts the amount straight onto the destination account's
// balance, so the receipt must be in that account's currency.
function assertCurrencyMatchesAccount(account: { currencyCode: string; accountName: string }, currencyCode: string) {
  if (account.currencyCode !== currencyCode) {
    throw new BadRequestError(`Currency (${currencyCode}) must match the destination account's currency (${account.currencyCode} - ${account.accountName}).`);
  }
}

export const incomingService = {
  async list(tenantId: string, query: ParsedListQuery, filters: { status?: string; destinationAccountId?: string; from?: string; to?: string }) {
    const where: any = { tenantId };
    if (filters.status) where.status = filters.status;
    if (filters.destinationAccountId) where.destinationAccountId = filters.destinationAccountId;
    if (filters.from || filters.to) {
      where.valueDate = {};
      if (filters.from) where.valueDate.gte = new Date(filters.from);
      if (filters.to) where.valueDate.lte = new Date(filters.to);
    }
    if (query.search) {
      where.OR = [
        { reference: { contains: query.search } },
        { sourceName: { contains: query.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.incomingTransaction.findMany({ where, include, skip: query.skip, take: query.take, orderBy: { [query.sortBy ?? "valueDate"]: query.sortDir } }),
      prisma.incomingTransaction.count({ where }),
    ]);
    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const row = await prisma.incomingTransaction.findFirst({ where: { id, tenantId }, include });
    if (!row) throw new NotFoundError("Incoming transaction not found");
    return serialize(row);
  },

  async create(tenantId: string, input: any, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id: input.destinationAccountId, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Destination account not found");
    assertCurrencyMatchesAccount(account, input.currencyCode);

    const reference = input.reference || `INC-${Date.now().toString(36).toUpperCase()}`;
    const row = await prisma.incomingTransaction.create({
      data: { ...input, tenantId, reference, valueDate: toDateOnly(input.valueDate), status: "EXPECTED" },
      include,
    });
    await auditService.record({ tenantId, actorId, action: "incoming.create", entityType: "IncomingTransaction", entityId: row.id, afterState: serialize(row) });
    return serialize(row);
  },

  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.incomingTransaction.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Incoming transaction not found");
    if (before.status !== "EXPECTED") throw new ConflictError("Only expected incoming transactions can be edited");

    const data = { ...input };
    if (data.valueDate) data.valueDate = toDateOnly(data.valueDate);
    if (data.destinationAccountId || data.currencyCode) {
      const account = await prisma.bankAccount.findFirst({ where: { id: data.destinationAccountId ?? before.destinationAccountId, tenantId, deletedAt: null } });
      if (!account) throw new NotFoundError("Destination account not found");
      assertCurrencyMatchesAccount(account, data.currencyCode ?? before.currencyCode);
    }
    const row = await prisma.incomingTransaction.update({ where: { id }, data, include });
    await auditService.record({ tenantId, actorId, action: "incoming.update", entityType: "IncomingTransaction", entityId: id, beforeState: before, afterState: serialize(row) });
    return serialize(row);
  },

  // Adjust the AR due date (audit-logged with an optional reason). Only an
  // expected receipt can move - once the money has landed the date is history.
  async reschedule(tenantId: string, id: string, input: { valueDate: string; reason?: string }, actorId: string) {
    const before = await prisma.incomingTransaction.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Incoming transaction not found");
    if (before.status !== "EXPECTED") throw new ConflictError("Only expected incoming transactions can be rescheduled");
    const valueDate = toDateOnly(input.valueDate);
    if (Number.isNaN(valueDate.getTime())) throw new BadRequestError("Invalid date");

    const row = await prisma.incomingTransaction.update({ where: { id }, data: { valueDate }, include });
    await auditService.record({
      tenantId,
      actorId,
      action: "incoming.reschedule",
      entityType: "IncomingTransaction",
      entityId: id,
      beforeState: { valueDate: before.valueDate },
      afterState: { valueDate, reason: input.reason },
    });
    return serialize(row);
  },

  // Funds have actually landed - posts a ledger entry that increases the
  // destination account balance and updates the cash position immediately.
  //
  // A float period (cheque clearing) leaves the ledger balance updated at
  // once but records a clearingDate: until then the amount is float, not
  // available balance (see treasury-desk/float.service.ts).
  async markReceived(tenantId: string, id: string, actorId: string, input: { floatDays?: number; clearingDate?: string } = {}) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.incomingTransaction.findFirst({ where: { id, tenantId } });
      if (!before) throw new NotFoundError("Incoming transaction not found");
      if (before.status !== "EXPECTED") throw new ConflictError("Only expected transactions can be marked received");

      await postLedgerEntry(tx, {
        tenantId,
        accountId: before.destinationAccountId,
        currencyCode: before.currencyCode,
        type: "INCOMING_IN",
        amount: Number(before.amount),
        reference: before.reference,
        description: `Incoming from ${before.sourceName}`,
        relatedIncomingId: before.id,
      });

      const floatDays = input.floatDays ?? before.floatDays;
      const clearingDate = input.clearingDate ? toDateOnly(input.clearingDate) : floatDays > 0 ? addBusinessDays(todayDateOnly(), floatDays) : null;
      return tx.incomingTransaction.update({ where: { id }, data: { status: "RECEIVED", floatDays, clearingDate }, include });
    });

    await auditService.record({ tenantId, actorId, action: "incoming.receive", entityType: "IncomingTransaction", entityId: id });
    return serialize(row);
  },

  async markReconciled(tenantId: string, id: string, actorId: string) {
    const before = await prisma.incomingTransaction.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Incoming transaction not found");
    if (before.status !== "RECEIVED") throw new BadRequestError("Only received transactions can be reconciled");

    const row = await prisma.incomingTransaction.update({ where: { id }, data: { status: "RECONCILED" }, include });
    await auditService.record({ tenantId, actorId, action: "incoming.reconcile", entityType: "IncomingTransaction", entityId: id });
    return serialize(row);
  },

  async cancel(tenantId: string, id: string, actorId: string) {
    const before = await prisma.incomingTransaction.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Incoming transaction not found");
    if (before.status !== "EXPECTED") throw new BadRequestError("Only expected transactions can be cancelled");

    const row = await prisma.incomingTransaction.update({ where: { id }, data: { status: "CANCELLED" }, include });
    await auditService.record({ tenantId, actorId, action: "incoming.cancel", entityType: "IncomingTransaction", entityId: id });
    return serialize(row);
  },
};
