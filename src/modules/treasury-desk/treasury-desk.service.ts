import { prisma } from "../../common/prisma";
import { addDays, diffDays, isoDate, localDayRange, toDateOnly, todayDateOnly } from "../../common/dates";
import { computeAccountMetrics } from "../../treasury-engine/cash-engine.service";
import { getActiveAccountsWithBank, toAccountLike } from "../bank-accounts/bank-accounts.service";
import { instrumentQuotasService } from "../instrument-quotas/instrument-quotas.service";
import { bankerAcceptancesService } from "../banker-acceptances/banker-acceptances.service";
import { forecastsService } from "../forecasts/forecasts.service";
import { dailyClosingBalances } from "./balance-series";

const round2 = (n: number) => Math.round(n * 100) / 100;
const STALE_AFTER_DAYS = 30;

interface MovementRow {
  collections: number; // received AR (INCOMING_IN)
  baDrawdown: number; // BA proceeds credited
  baSettlement: number; // BA repaid (debit)
  paymentsOut: number;
  transfersIn: number;
  transfersOut: number;
  adjustments: number; // explicit ADJUSTMENT ledger entries
}

const zeroMovement = (): MovementRow => ({ collections: 0, baDrawdown: 0, baSettlement: 0, paymentsOut: 0, transfersIn: 0, transfersOut: 0, adjustments: 0 });

// Treasury Service: the Daily Cash Desk - one place for "where does cash
// stand today, what moved, and what is coming", per bank account.
export const treasuryDeskService = {
  // Per-account daily position for one date: opening -> movements -> closing,
  // plus (for today) overdraft, float, reserve, available/liquidity and what
  // is scheduled to move today.
  async getDaily(tenantId: string, requested: Date) {
    const today = todayDateOnly();
    const date = requested > today ? today : requested;
    const isToday = date.getTime() === today.getTime();
    const { start, end } = localDayRange(date);

    const [accounts, ledger, series, dueIncoming, duePayments, dueBas, quotas, baSummary, upcomingBas] = await Promise.all([
      getActiveAccountsWithBank(tenantId),
      prisma.transaction.groupBy({ by: ["accountId", "type"], where: { tenantId, transactionDate: { gte: start, lt: end } }, _sum: { amount: true } }),
      dailyClosingBalances(tenantId, addDays(date, -1), date),
      isToday ? prisma.incomingTransaction.findMany({ where: { tenantId, status: "EXPECTED", valueDate: date }, select: { destinationAccountId: true, amount: true } }) : Promise.resolve([]),
      isToday
        ? prisma.payment.findMany({
            where: { tenantId, deletedAt: null, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] }, paymentDate: { gte: addDays(date, -STALE_AFTER_DAYS), lte: date } },
            select: { sourceAccountId: true, amount: true },
          })
        : Promise.resolve([]),
      isToday ? prisma.bankerAcceptance.findMany({ where: { tenantId, status: "OUTSTANDING", maturityDate: { lte: date } }, select: { settlementAccountId: true, faceAmount: true } }) : Promise.resolve([]),
      instrumentQuotasService.usage(tenantId, date),
      bankerAcceptancesService.summary(tenantId),
      prisma.bankerAcceptance.findMany({
        where: { tenantId, status: "OUTSTANDING", maturityDate: { lte: addDays(date, 14) } },
        include: { settlementAccount: { include: { bank: true } } },
        orderBy: { maturityDate: "asc" },
        take: 20,
      }),
    ]);

    const movement = new Map<string, MovementRow>();
    for (const row of ledger) {
      const m = movement.get(row.accountId) ?? zeroMovement();
      const amount = Number(row._sum.amount ?? 0);
      if (row.type === "INCOMING_IN") m.collections += amount;
      else if (row.type === "BA_DRAWDOWN") m.baDrawdown += amount;
      else if (row.type === "BA_SETTLEMENT") m.baSettlement += amount;
      else if (row.type === "PAYMENT_OUT") m.paymentsOut += amount;
      else if (row.type === "TRANSFER_IN") m.transfersIn += amount;
      else if (row.type === "TRANSFER_OUT") m.transfersOut += amount;
      else m.adjustments += amount;
      movement.set(row.accountId, m);
    }

    const sumBy = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
      const map = new Map<string, number>();
      for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + val(r));
      return map;
    };
    const expectedCollections = sumBy(dueIncoming, (r) => r.destinationAccountId, (r) => Number(r.amount));
    const scheduledPayments = sumBy(duePayments, (r) => r.sourceAccountId, (r) => Number(r.amount));
    const baMaturing = sumBy(dueBas, (r) => r.settlementAccountId, (r) => Number(r.faceAmount));

    const rows = accounts.map((a) => {
      const m = movement.get(a.id) ?? zeroMovement();
      const closingSeries = series.byAccount.get(a.id) ?? [null, null];
      const closing = closingSeries[1];
      const netMovement = m.collections + m.baDrawdown + m.transfersIn + m.adjustments - m.baSettlement - m.paymentsOut - m.transfersOut;
      // Opening is the previous day's close when we have one; otherwise it is
      // backed out of today's close and the ledger movements.
      const opening = closingSeries[0] ?? (closing !== null ? round2(closing - netMovement) : null);
      // Whatever moved the balance that the ledger doesn't explain - a manual
      // balance correction from a bank statement, most often.
      const otherMovement = closing !== null && opening !== null ? round2(closing - opening - netMovement) : 0;
      const metrics = computeAccountMetrics(toAccountLike(a));

      return {
        accountId: a.id,
        accountName: a.accountName,
        accountNumber: a.accountNumber,
        bankId: a.bankId,
        bankName: a.bank?.name ?? "",
        currencyCode: a.currencyCode,
        accountType: a.accountType,
        siteName: a.siteName ?? null,
        opening,
        collections: round2(m.collections),
        baDrawdown: round2(m.baDrawdown),
        baSettlement: round2(m.baSettlement),
        paymentsOut: round2(m.paymentsOut),
        transfersIn: round2(m.transfersIn),
        transfersOut: round2(m.transfersOut),
        otherMovement: round2(otherMovement + m.adjustments),
        closing,
        overdraftLimit: Number(a.overdraftLimit),
        overdraftUtilised: closing !== null ? round2(Math.max(0, -closing)) : 0,
        // Live-only figures - not reconstructable for a past date.
        reserved: isToday ? Number(a.reservedAmount) : null,
        floatDay1: isToday ? Number(a.floatDay1) : null,
        floatDay2: isToday ? Number(a.floatDay2) : null,
        floatTotal: isToday ? Number(a.floatAmount) : null,
        availableCash: isToday ? metrics.availableCash : null,
        liquidity: isToday ? metrics.liquidity : null,
        expectedCollections: isToday ? round2(expectedCollections.get(a.id) ?? 0) : null,
        scheduledPayments: isToday ? round2(scheduledPayments.get(a.id) ?? 0) : null,
        baMaturing: isToday ? round2(baMaturing.get(a.id) ?? 0) : null,
      };
    });

    // Per-currency totals (never summed across currencies).
    const totalsByCurrency = new Map<string, Record<string, number>>();
    const numericKeys = ["opening", "collections", "baDrawdown", "baSettlement", "paymentsOut", "transfersIn", "transfersOut", "otherMovement", "closing", "overdraftLimit", "overdraftUtilised", "floatDay1", "floatDay2", "floatTotal", "availableCash", "liquidity", "expectedCollections", "scheduledPayments", "baMaturing"] as const;
    for (const r of rows) {
      const t = totalsByCurrency.get(r.currencyCode) ?? Object.fromEntries(numericKeys.map((k) => [k, 0]));
      for (const k of numericKeys) t[k] = round2(t[k] + (r[k] ?? 0));
      totalsByCurrency.set(r.currencyCode, t);
    }

    return {
      date: isoDate(date),
      isToday,
      accounts: rows,
      totalsByCurrency: Array.from(totalsByCurrency.entries()).map(([currencyCode, totals]) => ({ currencyCode, ...totals })),
      quotas,
      reserves: buildReserves(accounts),
      bankerAcceptances: {
        summary: baSummary,
        upcoming: upcomingBas.map((b) => ({
          id: b.id,
          referenceNo: b.referenceNo,
          currencyCode: b.currencyCode,
          faceAmount: Number(b.faceAmount),
          maturityDate: b.maturityDate,
          daysToMaturity: diffDays(date, b.maturityDate),
          settlementAccountName: b.settlementAccount.accountName,
          bankName: b.settlementAccount.bank?.name ?? "",
        })),
      },
    };
  },

  // Bank x date grid: actual closing balances for the last `past` days, then
  // today's live balance, then the projected booked balance for `ahead` days
  // (the same figures the forecast is built on, so the two never disagree).
  async getBalanceGrid(tenantId: string, past: number, ahead: number) {
    const today = todayDateOnly();
    const from = addDays(today, -past);
    const to = addDays(today, ahead);

    const [{ byAccount }, projection, accounts] = await Promise.all([
      dailyClosingBalances(tenantId, from, today),
      forecastsService.buildProjection(tenantId, to),
      getActiveAccountsWithBank(tenantId),
    ]);
    const projectedById = new Map(projection.projections.map((p) => [p.projection.accountId, p.projection]));

    const dates = Array.from({ length: past + ahead + 1 }, (_, i) => {
      const d = addDays(from, i);
      return { date: isoDate(d), kind: (i < past ? "actual" : i === past ? "today" : "projected") as "actual" | "today" | "projected" };
    });

    type Cell = { balance: number | null; available: number | null };
    const buildCells = (accountId: string): Cell[] => {
      const actual = byAccount.get(accountId) ?? [];
      const proj = projectedById.get(accountId);
      return dates.map((d, i) => {
        if (d.kind === "projected") {
          const day = proj?.days[i - past];
          return { balance: day?.book ?? null, available: day?.available ?? null };
        }
        if (d.kind === "today") {
          const day = proj?.days[0];
          return { balance: actual[i] ?? null, available: day?.available ?? null };
        }
        return { balance: actual[i] ?? null, available: null };
      });
    };

    const accountRows = accounts
      .sort((a, b) => (a.bank?.name ?? "").localeCompare(b.bank?.name ?? "") || a.accountName.localeCompare(b.accountName))
      .map((a) => ({
        accountId: a.id,
        accountName: a.accountName,
        bankName: a.bank?.name ?? "",
        currencyCode: a.currencyCode,
        siteName: a.siteName ?? null,
        overdraftLimit: Number(a.overdraftLimit),
        cells: buildCells(a.id),
      }));

    // Manual forecast entries with no account belong to no bank row, but
    // they still move the company total - show them as their own row.
    for (const p of projection.projections) {
      if (!p.projection.unallocated) continue;
      accountRows.push({
        accountId: p.projection.accountId,
        accountName: p.projection.accountName,
        bankName: p.projection.bankName,
        currencyCode: p.projection.currencyCode,
        siteName: null,
        overdraftLimit: 0,
        cells: dates.map((d, i) => (d.kind === "projected" ? { balance: p.projection.days[i - past]?.book ?? null, available: p.projection.days[i - past]?.available ?? null } : d.kind === "today" ? { balance: 0, available: 0 } : { balance: null, available: null })),
      });
    }

    const totals = new Map<string, Cell[]>();
    for (const row of accountRows) {
      const t = totals.get(row.currencyCode) ?? dates.map((): Cell => ({ balance: 0, available: 0 }));
      row.cells.forEach((c, i) => {
        t[i] = {
          balance: c.balance === null || t[i].balance === null ? t[i].balance : round2((t[i].balance ?? 0) + c.balance),
          available: c.available === null || t[i].available === null ? null : round2((t[i].available ?? 0) + c.available),
        };
      });
      totals.set(row.currencyCode, t);
    }

    return {
      dates,
      accounts: accountRows,
      totalsByCurrency: Array.from(totals.entries()).map(([currencyCode, cells]) => ({ currencyCode, cells })),
    };
  },

  // Cash reserve by site/entity (e.g. PJRM, Bukit Raja) - see buildReserves.
  async getReserves(tenantId: string) {
    return buildReserves(await getActiveAccountsWithBank(tenantId));
  },
};

// A site's cash reserve = cash deliberately held back there:
//   - reservedAmount earmarked on its ordinary accounts, plus
//   - the whole balance of accounts of type RESERVE.
// (A RESERVE account's own reservedAmount is not added again - it is already
// counted by taking the whole balance.) Kept per currency: never summed across.
function buildReserves(accounts: any[]) {
  interface ReserveSite {
    siteName: string;
    currencyCode: string;
    earmarked: number;
    reserveAccountBalance: number;
    accounts: { accountId: string; accountName: string; bankName: string; accountType: string; amount: number }[];
  }
  const sites = new Map<string, ReserveSite>();
  for (const a of accounts) {
    const isReserveAccount = a.accountType === "RESERVE";
    const amount = isReserveAccount ? Math.max(0, Number(a.currentBalance)) : Number(a.reservedAmount);
    if (amount === 0 && !isReserveAccount) continue;
    const siteName = a.siteName ?? "Unassigned";
    const key = `${siteName}::${a.currencyCode}`;
    const entry: ReserveSite = sites.get(key) ?? { siteName, currencyCode: a.currencyCode, earmarked: 0, reserveAccountBalance: 0, accounts: [] };
    if (isReserveAccount) entry.reserveAccountBalance = round2(entry.reserveAccountBalance + amount);
    else entry.earmarked = round2(entry.earmarked + amount);
    entry.accounts.push({ accountId: a.id, accountName: a.accountName, bankName: a.bank?.name ?? "", accountType: a.accountType, amount: round2(amount) });
    sites.set(key, entry);
  }
  return Array.from(sites.values())
    .map((s) => ({ ...s, total: round2(s.earmarked + s.reserveAccountBalance) }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName) || a.currencyCode.localeCompare(b.currencyCode));
}
