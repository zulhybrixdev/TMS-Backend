import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, LimitReachedError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { AccountLike, computeAccountMetrics } from "../../treasury-engine/cash-engine.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";
import { PLAN_CATALOG, PLAN_KEYS, PlanKeyValue } from "../../common/plans";
import { floatService } from "../treasury-desk/float.service";
import { toDateOnly, todayDateOnly } from "../../common/dates";

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
    overdraftLimit: Number(account.overdraftLimit ?? 0),
    floatAmount: Number(account.floatAmount ?? 0),
  };
}

// Attaches uncleared cheque float (see float.service.ts) to raw account rows
// so toAccountLike()/serializeAccount() can net it out of available cash.
// Accounts with no float just get zeros.
export async function withFloat<T extends { id: string }>(tenantId: string, accounts: T[]) {
  if (accounts.length === 0) return accounts.map((a) => ({ ...a, floatAmount: 0, floatDay1: 0, floatDay2: 0 }));
  const floats = await floatService.byAccount(tenantId, accounts.map((a) => a.id));
  return accounts.map((a) => {
    const f = floats.get(a.id) ?? floatService.empty();
    return { ...a, floatAmount: f.total, floatDay1: f.day1, floatDay2: f.day2 };
  });
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
    overdraftLimit: metrics.overdraftLimit ?? 0,
    overdraftUtilised: metrics.overdraftUtilised,
    overdraftAvailable: metrics.overdraftAvailable,
    siteName: account.siteName ?? null,
    floatDay1: Number(account.floatDay1 ?? 0),
    floatDay2: Number(account.floatDay2 ?? 0),
    floatTotal: Number(account.floatAmount ?? 0),
    liquidity: metrics.liquidity,
    availableCash: metrics.availableCash,
    shortfall: metrics.shortfall,
    excessCash: metrics.excessCash,
    cashStatus: metrics.status,
  };
}

export async function getActiveAccountsWithBank(tenantId: string) {
  const accounts = await prisma.bankAccount.findMany({ where: { tenantId, status: "ACTIVE", deletedAt: null }, include: accountInclude });
  return withFloat(tenantId, accounts);
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

    return { items: (await withFloat(tenantId, rows)).map(serializeAccount), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null }, include: accountInclude });
    if (!account) throw new NotFoundError("Bank account not found");
    return serializeAccount((await withFloat(tenantId, [account]))[0]);
  },

  // Picklist for the site/entity field (e.g. PJRM, Bukit Raja) - suggests
  // values already in use so the same site isn't typed two different ways.
  async listSites(tenantId: string) {
    const rows = await prisma.bankAccount.findMany({ where: { tenantId, deletedAt: null, siteName: { not: null } }, select: { siteName: true }, distinct: ["siteName"], orderBy: { siteName: "asc" } });
    return rows.map((r) => r.siteName!).filter(Boolean);
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

    // The opening balance also becomes today's snapshot, so the daily
    // balance history starts the day the account was added instead of only
    // once its first movement is posted.
    const account = await prisma.$transaction(async (tx) => {
      const created = await tx.bankAccount.create({ data: { ...input, tenantId, lastBalanceAt: new Date() }, include: accountInclude });
      const balance = Number(input.currentBalance ?? 0);
      await tx.accountBalance.create({
        data: {
          tenantId,
          accountId: created.id,
          currencyCode: created.currencyCode,
          balanceDate: todayDateOnly(),
          openingBalance: balance,
          closingBalance: balance,
          availableBalance: balance - Number(created.reservedAmount),
          source: "SYSTEM",
          updatedById: actorId,
        },
      });
      return created;
    });
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
    return serializeAccount((await withFloat(tenantId, [account]))[0]);
  },

  // Manual balance entry (e.g. from a bank statement) - Phase 1 has no live
  // bank feed, so Finance records balances here. Writes both the daily
  // snapshot and the account's current balance.
  async recordBalance(tenantId: string, id: string, input: { balanceDate: string; closingBalance: number; availableBalance?: number }, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Bank account not found");

    const balanceDate = toDateOnly(input.balanceDate);
    if (Number.isNaN(balanceDate.getTime())) throw new BadRequestError("Invalid balance date");
    if (balanceDate > todayDateOnly()) throw new BadRequestError("A balance cannot be recorded for a future date");
    // A backdated entry corrects that day's history only - the account's
    // current balance is whatever is true now, so it must not be overwritten
    // by an older statement figure.
    const isCurrent = balanceDate.getTime() === todayDateOnly().getTime();
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
        data: isCurrent ? { currentBalance: input.closingBalance, lastBalanceAt: new Date() } : { lastBalanceAt: new Date() },
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
      afterState: { balanceDate: input.balanceDate, closingBalance: input.closingBalance, updatedCurrentBalance: isCurrent },
    });

    return serializeAccount((await withFloat(tenantId, [result.updated]))[0]);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Bank account not found");
    // An account that still has a banker acceptance to settle, cash held as
    // uncleared float, or scheduled payments/transfers can't just disappear.
    const [openBas, floating, scheduled] = await Promise.all([
      prisma.bankerAcceptance.count({ where: { tenantId, status: "OUTSTANDING", OR: [{ creditAccountId: id }, { settlementAccountId: id }] } }),
      floatService.forAccount(tenantId, id),
      Promise.all([
        prisma.payment.count({ where: { tenantId, deletedAt: null, sourceAccountId: id, status: { in: ["PENDING_APPROVAL", "APPROVED"] } } }),
        prisma.transfer.count({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED"] }, OR: [{ sourceAccountId: id }, { destinationAccountId: id }] } }),
      ]).then(([p, t]) => p + t),
    ]);
    if (openBas > 0) throw new ConflictError("This account has outstanding banker acceptances - settle them before closing it");
    if (floating.total > 0) throw new ConflictError("This account still holds uncleared cheque float - close it once that has cleared");
    if (scheduled > 0) throw new ConflictError("This account has payments or transfers awaiting approval or release - cancel or complete them first");
    await prisma.bankAccount.update({ where: { id }, data: { status: "CLOSED", deletedAt: new Date() } });
    await auditService.record({ tenantId, actorId, action: "bank_account.close", entityType: "BankAccount", entityId: id });
    return { closed: true };
  },
};
