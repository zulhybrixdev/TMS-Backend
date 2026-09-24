import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { postLedgerEntry } from "../../treasury-engine/ledger.service";
import { diffDays, toDateOnly, todayDateOnly } from "../../common/dates";
import { ParsedListQuery, buildMeta } from "../../common/pagination";

const include = {
  creditAccount: { include: { bank: true } },
  settlementAccount: { include: { bank: true } },
  createdBy: { select: { id: true, name: true } },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function serialize(row: any) {
  const face = Number(row.faceAmount);
  const proceeds = Number(row.proceedsAmount);
  const tenorDays = Math.max(1, diffDays(row.drawdownDate, row.maturityDate));
  const discountAmount = round2(face - proceeds);
  const today = todayDateOnly();
  return {
    id: row.id,
    referenceNo: row.referenceNo,
    currencyCode: row.currencyCode,
    creditAccountId: row.creditAccountId,
    creditAccountName: row.creditAccount?.accountName,
    creditBankName: row.creditAccount?.bank?.name,
    settlementAccountId: row.settlementAccountId,
    settlementAccountName: row.settlementAccount?.accountName,
    settlementBankName: row.settlementAccount?.bank?.name,
    faceAmount: face,
    proceedsAmount: proceeds,
    drawdownDate: row.drawdownDate,
    maturityDate: row.maturityDate,
    tenorDays,
    // Cost of the facility: what is repaid beyond what was received, and
    // that as a simple annualised rate on the cash actually received
    // (actual/365), the usual way a BA's all-in cost is quoted.
    discountAmount,
    effectiveRatePa: proceeds > 0 ? round2(((discountAmount / proceeds) * (365 / tenorDays)) * 100) : 0,
    status: row.status,
    settledDate: row.settledDate,
    settledAmount: row.settledAmount == null ? null : Number(row.settledAmount),
    daysToMaturity: row.status === "OUTSTANDING" ? diffDays(today, row.maturityDate) : null,
    isOverdue: row.status === "OUTSTANDING" && row.maturityDate < today,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

// Treasury Service: banker acceptance (BA) facility usage. Drawdown credits
// the proceeds to a bank account (a ledger inflow of type BA_DRAWDOWN);
// settlement at maturity debits the amount repaid (BA_SETTLEMENT). Both go
// through the same ledger as every other cash movement, so they show up in
// balances, daily movement and the forecast (an outstanding BA is a debit on
// its maturity date) with no special-casing anywhere else.
export const bankerAcceptancesService = {
  async list(tenantId: string, query: ParsedListQuery, filters: { status?: string }) {
    const where: any = { tenantId };
    if (filters.status) where.status = filters.status;
    if (query.search) where.OR = [{ referenceNo: { contains: query.search } }, { description: { contains: query.search } }];

    const [rows, total] = await Promise.all([
      prisma.bankerAcceptance.findMany({ where, include, skip: query.skip, take: query.take, orderBy: { [query.sortBy ?? "maturityDate"]: query.sortDir } }),
      prisma.bankerAcceptance.count({ where }),
    ]);
    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const row = await prisma.bankerAcceptance.findFirst({ where: { id, tenantId }, include });
    if (!row) throw new NotFoundError("Banker acceptance not found");
    return serialize(row);
  },

  // Outstanding BA exposure by currency + what falls due soon - the headline
  // numbers for the BA screen.
  async summary(tenantId: string) {
    const outstanding = await prisma.bankerAcceptance.findMany({ where: { tenantId, status: "OUTSTANDING" }, select: { currencyCode: true, faceAmount: true, maturityDate: true } });
    const today = todayDateOnly();
    const byCurrency = new Map<string, { outstanding: number; dueIn7Days: number; overdue: number; count: number }>();
    for (const r of outstanding) {
      const e = byCurrency.get(r.currencyCode) ?? { outstanding: 0, dueIn7Days: 0, overdue: 0, count: 0 };
      const face = Number(r.faceAmount);
      e.outstanding = round2(e.outstanding + face);
      e.count += 1;
      const days = diffDays(today, r.maturityDate);
      if (days < 0) e.overdue = round2(e.overdue + face);
      else if (days <= 7) e.dueIn7Days = round2(e.dueIn7Days + face);
      byCurrency.set(r.currencyCode, e);
    }
    return Array.from(byCurrency.entries()).map(([currencyCode, v]) => ({ currencyCode, ...v }));
  },

  async create(tenantId: string, input: any, actorId: string) {
    const [credit, settlement, dup] = await Promise.all([
      prisma.bankAccount.findFirst({ where: { id: input.creditAccountId, tenantId, deletedAt: null } }),
      input.settlementAccountId ? prisma.bankAccount.findFirst({ where: { id: input.settlementAccountId, tenantId, deletedAt: null } }) : Promise.resolve(null),
      prisma.bankerAcceptance.findFirst({ where: { tenantId, referenceNo: input.referenceNo } }),
    ]);
    if (!credit) throw new NotFoundError("Credit account not found");
    if (input.settlementAccountId && !settlement) throw new NotFoundError("Settlement account not found");
    if (dup) throw new ConflictError(`A banker acceptance with reference ${input.referenceNo} already exists`);
    const settleAccount = settlement ?? credit;
    if (settleAccount.currencyCode !== credit.currencyCode) {
      throw new BadRequestError("Credit and settlement accounts must be in the same currency");
    }

    const row = await prisma.$transaction(async (tx) => {
      const ba = await tx.bankerAcceptance.create({
        data: {
          tenantId,
          referenceNo: input.referenceNo,
          creditAccountId: credit.id,
          settlementAccountId: settleAccount.id,
          currencyCode: credit.currencyCode,
          faceAmount: input.faceAmount,
          proceedsAmount: input.proceedsAmount,
          drawdownDate: toDateOnly(input.drawdownDate),
          maturityDate: toDateOnly(input.maturityDate),
          description: input.description,
          createdById: actorId,
        },
      });
      await postLedgerEntry(tx, {
        tenantId,
        accountId: credit.id,
        currencyCode: credit.currencyCode,
        type: "BA_DRAWDOWN",
        amount: input.proceedsAmount,
        reference: input.referenceNo,
        description: `Banker acceptance drawdown ${input.referenceNo} (face ${input.faceAmount.toLocaleString()}, matures ${input.maturityDate.slice(0, 10)})`,
        relatedBaId: ba.id,
      });
      return tx.bankerAcceptance.findUniqueOrThrow({ where: { id: ba.id }, include });
    });

    await auditService.record({ tenantId, actorId, action: "banker_acceptance.drawdown", entityType: "BankerAcceptance", entityId: row.id, afterState: serialize(row) });
    return serialize(row);
  },

  async settle(tenantId: string, id: string, input: { settledDate?: string; settledAmount?: number }, actorId: string) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.bankerAcceptance.findFirst({ where: { id, tenantId } });
      if (!before) throw new NotFoundError("Banker acceptance not found");
      if (before.status !== "OUTSTANDING") throw new ConflictError("This banker acceptance has already been settled");

      const settledAmount = input.settledAmount ?? Number(before.faceAmount);
      await postLedgerEntry(tx, {
        tenantId,
        accountId: before.settlementAccountId,
        currencyCode: before.currencyCode,
        type: "BA_SETTLEMENT",
        amount: settledAmount,
        reference: before.referenceNo,
        description: `Banker acceptance settlement ${before.referenceNo}`,
        relatedBaId: before.id,
      });
      return tx.bankerAcceptance.update({
        where: { id },
        data: { status: "SETTLED", settledAmount, settledDate: input.settledDate ? toDateOnly(input.settledDate) : todayDateOnly() },
        include,
      });
    });

    await auditService.record({ tenantId, actorId, action: "banker_acceptance.settle", entityType: "BankerAcceptance", entityId: id, afterState: serialize(row) });
    return serialize(row);
  },
};
