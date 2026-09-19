import { prisma } from "../../common/prisma";
import { ConflictError, LimitReachedError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { AccountLike, computeAccountMetrics } from "../../treasury-engine/cash-engine.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";
import { PLAN_CATALOG, PLAN_KEYS, PlanKeyValue } from "../../common/plans";

const accountInclude = { bank: true, currency: true };

// Shared mapper reused by cash-position, dashboard, and transfers modules so
// every screen computes the same Available/Shortfall/Excess figures from the
// treasury cash engine rather than re-deriving them ad hoc.
export function toAccountLike(account: any): AccountLike {
  return {
    id: account.id,
    accountName: account.accountName,
    bankName: account.bank?.name ?? "",
    currencyCode: account.currencyCode,
    currentBalance: Number(account.currentBalance),
    reservedAmount: Number(account.reservedAmount),
    minimumBalance: Number(account.minimumBalance),
    targetBalance: Number(account.targetBalance),
  };
}

export function serializeAccount(account: any) {
  const metrics = computeAccountMetrics(toAccountLike(account));
  return {
    id: account.id,
    bankId: account.bankId,
    bankName: account.bank?.name,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    currencyCode: account.currencyCode,
    accountType: account.accountType,
    status: account.status,
    lastBalanceAt: account.lastBalanceAt,
    updatedAt: account.updatedAt,
    currentBalance: Number(account.currentBalance),
    reservedAmount: Number(account.reservedAmount),
    minimumBalance: Number(account.minimumBalance),
    targetBalance: Number(account.targetBalance),
    availableCash: metrics.availableCash,
    shortfall: metrics.shortfall,
    excessCash: metrics.excessCash,
    cashStatus: metrics.status,
  };
}

export async function getActiveAccountsWithBank(tenantId: string) {
  return prisma.bankAccount.findMany({ where: { tenantId, status: "ACTIVE", deletedAt: null }, include: accountInclude });
}

async function assertAccountSlotAvailable(tenantId: string) {
  const [subscription, currentCount] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId } }),
    prisma.bankAccount.count({ where: { tenantId, deletedAt: null } }),
  ]);
  const planKey = (subscription?.planKey ?? PLAN_KEYS.FREE) as PlanKeyValue;
  const limit = PLAN_CATALOG[planKey].limits.bankAccounts;
  if (limit !== null && currentCount >= limit) {
    throw new LimitReachedError(`Your ${PLAN_CATALOG[planKey].name} plan is limited to ${limit} bank accounts. Upgrade to add more.`);
  }
}

export const bankAccountsService = {
  async list(tenantId: string, query: ParsedListQuery, filters: { bankId?: string; currencyCode?: string; status?: string }) {
    const where: any = { tenantId, deletedAt: null };
    if (filters.bankId) where.bankId = filters.bankId;
    if (filters.currencyCode) where.currencyCode = filters.currencyCode;
    if (filters.status) where.status = filters.status;
    if (query.search) {
      where.OR = [
        { accountName: { contains: query.search } },
        { accountNumber: { contains: query.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.bankAccount.findMany({
        where,
        include: accountInclude,
        skip: query.skip,
        take: query.take,
        orderBy: { [query.sortBy ?? "accountName"]: query.sortDir },
      }),
      prisma.bankAccount.count({ where }),
    ]);

    return { items: rows.map(serializeAccount), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null }, include: accountInclude });
    if (!account) throw new NotFoundError("Bank account not found");
    return serializeAccount(account);
  },

  async getBalanceHistory(tenantId: string, id: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return prisma.accountBalance.findMany({
      where: { tenantId, accountId: id, balanceDate: { gte: since } },
      orderBy: { balanceDate: "asc" },
    });
  },

  async create(tenantId: string, input: any, actorId: string) {
    const bank = await prisma.bank.findFirst({ where: { id: input.bankId, tenantId, deletedAt: null } });
    if (!bank) throw new NotFoundError("Bank not found");
    const currency = await prisma.currency.findUnique({ where: { code: input.currencyCode } });
    if (!currency) throw new NotFoundError("Currency not found");

    const dup = await prisma.bankAccount.findFirst({ where: { accountNumber: input.accountNumber, bankId: input.bankId, tenantId, deletedAt: null } });
    if (dup) throw new ConflictError("An account with this number already exists at this bank");

    await assertAccountSlotAvailable(tenantId);

    const account = await prisma.bankAccount.create({ data: { ...input, tenantId, lastBalanceAt: new Date() }, include: accountInclude });
    await auditService.record({ tenantId, actorId, action: "bank_account.create", entityType: "BankAccount", entityId: account.id, afterState: serializeAccount(account) });
    return serializeAccount(account);
  },

  // Powers "Allow Finance users to configure minimum/target balances" plus
  // general edits (reserved amount, status, account type).
  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null }, include: accountInclude });
    if (!before) throw new NotFoundError("Bank account not found");

    const account = await prisma.bankAccount.update({ where: { id }, data: input, include: accountInclude });
    await auditService.record({
      tenantId,
      actorId,
      action: "bank_account.update",
      entityType: "BankAccount",
      entityId: id,
      beforeState: serializeAccount(before),
      afterState: serializeAccount(account),
    });
    return serializeAccount(account);
  },

  // Manual balance entry (e.g. from a bank statement) - Phase 1 has no live
  // bank feed, so Finance records balances here. Writes both the daily
  // snapshot and the account's current balance.
  async recordBalance(tenantId: string, id: string, input: { balanceDate: string; closingBalance: number; availableBalance?: number }, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Bank account not found");

    const balanceDate = new Date(input.balanceDate);
    const availableBalance = input.availableBalance ?? input.closingBalance - Number(account.reservedAmount);

    const result = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.accountBalance.upsert({
        where: { accountId_balanceDate: { accountId: id, balanceDate } },
        create: {
          tenantId,
          accountId: id,
          currencyCode: account.currencyCode,
          balanceDate,
          openingBalance: Number(account.currentBalance),
          closingBalance: input.closingBalance,
          availableBalance,
          source: "MANUAL",
          updatedById: actorId,
        },
        update: { closingBalance: input.closingBalance, availableBalance, source: "MANUAL", updatedById: actorId },
      });
      const updated = await tx.bankAccount.update({
        where: { id },
        data: { currentBalance: input.closingBalance, lastBalanceAt: new Date() },
        include: accountInclude,
      });
      return { snapshot, updated };
    });

    await auditService.record({
      tenantId,
      actorId,
      action: "bank_account.balance_update",
      entityType: "BankAccount",
      entityId: id,
      beforeState: { currentBalance: Number(account.currentBalance) },
      afterState: { currentBalance: input.closingBalance },
    });

    return serializeAccount(result.updated);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Bank account not found");
    await prisma.bankAccount.update({ where: { id }, data: { status: "CLOSED", deletedAt: new Date() } });
    await auditService.record({ tenantId, actorId, action: "bank_account.close", entityType: "BankAccount", entityId: id });
    return { closed: true };
  },
};
