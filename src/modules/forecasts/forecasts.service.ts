import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { getActiveAccountsWithBank, withFloat } from "../bank-accounts/bank-accounts.service";
import { addBusinessDays, diffDays, isoDate, addDays, toDateOnly, todayDateOnly } from "../../common/dates";
import { getRatesToBase } from "../fx/base-rates";

const include = { account: { include: { bank: true } }, currency: true };

function serialize(row: any) {
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.account?.accountName ?? "All accounts",
    currencyCode: row.currencyCode,
    forecastDate: row.forecastDate,
    category: row.category,
    sourceType: row.sourceType,
    sourceReference: row.sourceReference,
    amount: Number(row.amount),
    confidence: row.confidence,
    description: row.description,
    createdAt: row.createdAt,
  };
}

// Company-wide (all accounts, base-currency) view of one day.
export interface ProjectionPoint {
  date: string;
  inflow: number;
  outflow: number;
  netChange: number;
  /** Projected *available* balance: booked balance less reserved amounts and uncleared float. */
  projectedBalance: number;
  /** Projected available balance plus the overdraft facilities. */
  projectedLiquidity: number;
  /** Accounts that would breach their minimum balance even after drawing their overdraft. */
  shortfallAccounts: string[];
  /** Accounts that would be drawing on their overdraft (available < 0). */
  overdraftAccounts: string[];
  /** Accounts sitting above their target balance. */
  excessAccounts: string[];
}

export interface AccountProjectionDay {
  date: string;
  inflow: number;
  outflow: number;
  /** Booked (ledger) balance at the end of the day. */
  book: number;
  /** Book less reserved amount and float not yet cleared by that day. */
  available: number;
  /** available + overdraft limit. */
  liquidity: number;
}

export interface AccountProjection {
  accountId: string;
  accountName: string;
  bankId: string | null;
  bankName: string;
  currencyCode: string;
  siteName: string | null;
  overdraftLimit: number;
  minimumBalance: number;
  targetBalance: number;
  /** True for the per-currency bucket holding manual entries not tied to an account. */
  unallocated: boolean;
  days: AccountProjectionDay[];
}

export interface ProjectionDetail {
  from: string;
  to: string;
  baseCurrency: string;
  currencyFilter: string | null;
  points: ProjectionPoint[];
  accounts: AccountProjection[];
  /** Currencies left out of the base-currency totals because no FX rate was available. */
  unconvertedCurrencies: string[];
  /** False when the plan doesn't include converted totals: only base-currency accounts are totalled. */
  fxConversion: boolean;
  overdue: {
    /** Unpaid AP / BA settlements already past due - counted as going out today. */
    payables: { currencyCode: string; amount: number; count: number }[];
    /** Expected AR already past its date and still not received - NOT counted (prudent). */
    receivables: { currencyCode: string; amount: number; count: number }[];
  };
}

interface Slot {
  inflow: number;
  outflow: number;
  transferIn: number;
  transferOut: number;
}

interface AccountState {
  meta: Omit<AccountProjection, "days">;
  startBook: number;
  reserved: number;
  slots: Slot[];
  /** Float added on `diff[bookIdx]` and released on `diff[clearIdx]` - a difference array over days. */
  floatDiff: number[];
}

const MAX_HORIZON_DAYS = 366;
// Unpaid drafts/pending items older than this are treated as stale rather than
// as overdue obligations, so a forgotten draft from months ago can't suddenly
// land on today's outflow.
const STALE_AFTER_DAYS = 30;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Treasury Service: cash forecasting. Manual entries (cash_forecasts table)
// are combined on the fly with system-derived flows - pending/approved
// payments (outflow), expected incoming transactions (inflow), and
// pending/approved transfers (outflow at source, inflow at destination) -
// so the projection always reflects the live pipeline without having to
// keep a duplicate materialised copy in sync.
export const forecastsService = {
  async list(tenantId: string, filters: { from?: string; to?: string; accountId?: string }) {
    const where: any = { tenantId };
    if (filters.accountId) where.accountId = filters.accountId;
    if (filters.from || filters.to) {
      where.forecastDate = {};
      if (filters.from) where.forecastDate.gte = new Date(filters.from);
      if (filters.to) where.forecastDate.lte = new Date(filters.to);
    }
    const rows = await prisma.cashForecast.findMany({ where, include, orderBy: { forecastDate: "asc" } });
    return rows.map(serialize);
  },

  async create(tenantId: string, input: any, actorId: string) {
    const row = await prisma.cashForecast.create({
      data: { ...input, tenantId, forecastDate: new Date(input.forecastDate), sourceType: "MANUAL" },
      include,
    });
    await auditService.record({ tenantId, actorId, action: "forecast.create", entityType: "CashForecast", entityId: row.id, afterState: serialize(row) });
    return serialize(row);
  },

  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.cashForecast.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Forecast entry not found");
    if (before.sourceType !== "MANUAL") throw new NotFoundError("Only manual forecast entries can be edited");

    const data = { ...input };
    if (data.forecastDate) data.forecastDate = new Date(data.forecastDate);
    const row = await prisma.cashForecast.update({ where: { id }, data, include });
    await auditService.record({ tenantId, actorId, action: "forecast.update", entityType: "CashForecast", entityId: id, beforeState: before, afterState: serialize(row) });
    return serialize(row);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const before = await prisma.cashForecast.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Forecast entry not found");
    await prisma.cashForecast.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "forecast.delete", entityType: "CashForecast", entityId: id, beforeState: before });
    return { deleted: true };
  },

  // Builds the per-account day-by-day projection everything else is derived
  // from. Simulates from *today* (the balances we actually know) to `to`,
  // whatever `from` the caller wants to see.
  //
  //   book_d       = book_(d-1) + inflow_d - outflow_d
  //   available_d  = book_d - reserved - float not yet cleared on day d
  //   liquidity_d  = available_d + overdraft limit
  //
  // Sources: payments (AP) on their due date, expected receipts (AR) on their
  // value date - usable only after their float days - uncleared float on its
  // clearing date, transfers on their date (both legs), outstanding banker
  // acceptances on maturity, and manual entries. Unpaid AP and BA
  // settlements already past due count as going out today; overdue AR does not
  // count as coming in.
  async buildProjection(tenantId: string, to: Date, filters: { accountId?: string; currencyCode?: string } = {}) {
    const today = todayDateOnly();
    const end = toDateOnly(to) < today ? today : toDateOnly(to);
    const nDays = Math.min(MAX_HORIZON_DAYS, diffDays(today, end) + 1);
    const lastDay = addDays(today, nDays - 1);
    const staleBefore = addDays(today, -STALE_AFTER_DAYS);

    const accountRows = await withFloat(tenantId, await getActiveAccountsWithBank(tenantId));
    const accounts = accountRows.filter((a) => (!filters.accountId || a.id === filters.accountId) && (!filters.currencyCode || a.currencyCode === filters.currencyCode));
    const inScope = new Set(accounts.map((a) => a.id));

    const emptySlots = () => Array.from({ length: nDays }, (): Slot => ({ inflow: 0, outflow: 0, transferIn: 0, transferOut: 0 }));
    const states = new Map<string, AccountState>();
    for (const a of accounts) {
      states.set(a.id, {
        meta: {
          accountId: a.id,
          accountName: a.accountName,
          bankId: a.bankId,
          bankName: a.bank?.name ?? "",
          currencyCode: a.currencyCode,
          siteName: a.siteName ?? null,
          overdraftLimit: Number(a.overdraftLimit),
          minimumBalance: Number(a.minimumBalance),
          targetBalance: Number(a.targetBalance),
          unallocated: false,
        },
        startBook: Number(a.currentBalance),
        reserved: Number(a.reservedAmount),
        slots: emptySlots(),
        floatDiff: new Array(nDays + 1).fill(0),
      });
    }

    // Manual entries with no account: kept in a per-currency bucket so they
    // still reach the company total without being attributed to a bank.
    const unallocated = (currencyCode: string): AccountState | undefined => {
      if (filters.accountId || (filters.currencyCode && filters.currencyCode !== currencyCode)) return undefined;
      const key = `unallocated:${currencyCode}`;
      if (!states.has(key)) {
        states.set(key, {
          meta: { accountId: key, accountName: `Unallocated (${currencyCode})`, bankId: null, bankName: "Manual entries", currencyCode, siteName: null, overdraftLimit: 0, minimumBalance: 0, targetBalance: 0, unallocated: true },
          startBook: 0,
          reserved: 0,
          slots: emptySlots(),
          floatDiff: new Array(nDays + 1).fill(0),
        });
      }
      return states.get(key);
    };

    const dayIndex = (d: Date) => diffDays(today, toDateOnly(d));
    const clampIdx = (d: Date) => Math.max(0, dayIndex(d));
    const overduePayables = new Map<string, { amount: number; count: number }>();
    const overdueReceivables = new Map<string, { amount: number; count: number }>();
    const bumpOverdue = (map: typeof overduePayables, currency: string, amount: number) => {
      const e = map.get(currency) ?? { amount: 0, count: 0 };
      e.amount = round2(e.amount + amount);
      e.count += 1;
      map.set(currency, e);
    };
    const addOut = (accountId: string, date: Date, amount: number, kind: "transfer" | "plain") => {
      const st = states.get(accountId);
      const idx = clampIdx(date);
      if (!st || idx >= nDays) return;
      st.slots[idx].outflow += amount;
      if (kind === "transfer") st.slots[idx].transferOut += amount;
    };
    const addIn = (accountId: string, date: Date, amount: number, kind: "transfer" | "plain") => {
      const st = states.get(accountId);
      const idx = clampIdx(date);
      if (!st || idx >= nDays) return;
      st.slots[idx].inflow += amount;
      if (kind === "transfer") st.slots[idx].transferIn += amount;
    };

    const [manual, payments, incoming, floatHeld, transfers, bas] = await Promise.all([
      prisma.cashForecast.findMany({ where: { tenantId, forecastDate: { gte: today, lte: lastDay } } }),
      prisma.payment.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED", "DRAFT"] }, paymentDate: { gte: staleBefore, lte: lastDay }, deletedAt: null } }),
      prisma.incomingTransaction.findMany({ where: { tenantId, status: "EXPECTED", valueDate: { lte: lastDay } } }),
      prisma.incomingTransaction.findMany({ where: { tenantId, status: { in: ["RECEIVED", "RECONCILED"] }, clearingDate: { gt: today } }, select: { destinationAccountId: true, amount: true, clearingDate: true } }),
      prisma.transfer.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED", "DRAFT"] }, transferDate: { gte: staleBefore, lte: lastDay } } }),
      prisma.bankerAcceptance.findMany({ where: { tenantId, status: "OUTSTANDING", maturityDate: { lte: lastDay } } }),
    ]);

    for (const m of manual) {
      const target = m.accountId ? (inScope.has(m.accountId) ? m.accountId : undefined) : unallocated(m.currencyCode)?.meta.accountId;
      if (!target) continue;
      const amount = Number(m.amount);
      if (m.category === "INFLOW") addIn(target, m.forecastDate, amount, "plain");
      else addOut(target, m.forecastDate, amount, "plain");
    }

    for (const p of payments) {
      if (!inScope.has(p.sourceAccountId)) continue;
      const amount = Number(p.amount);
      if (dayIndex(p.paymentDate) < 0) bumpOverdue(overduePayables, p.currencyCode, amount);
      addOut(p.sourceAccountId, p.paymentDate, amount, "plain");
    }

    for (const t of transfers) {
      const amount = Number(t.amount);
      addOut(t.sourceAccountId, t.transferDate, amount, "transfer");
      addIn(t.destinationAccountId, t.transferDate, amount, "transfer");
    }

    for (const ba of bas) {
      if (!inScope.has(ba.settlementAccountId)) continue;
      const amount = Number(ba.faceAmount);
      if (dayIndex(ba.maturityDate) < 0) bumpOverdue(overduePayables, ba.currencyCode, amount);
      addOut(ba.settlementAccountId, ba.maturityDate, amount, "plain");
    }

    for (const i of incoming) {
      if (!inScope.has(i.destinationAccountId)) continue;
      const amount = Number(i.amount);
      const bookIdx = dayIndex(i.valueDate);
      if (bookIdx < 0) {
        bumpOverdue(overdueReceivables, i.currencyCode, amount);
        continue;
      }
      addIn(i.destinationAccountId, i.valueDate, amount, "plain");
      if (i.floatDays > 0) {
        const st = states.get(i.destinationAccountId)!;
        const clearIdx = dayIndex(addBusinessDays(toDateOnly(i.valueDate), i.floatDays));
        if (bookIdx < nDays) {
          st.floatDiff[bookIdx] += amount;
          st.floatDiff[Math.min(clearIdx, nDays)] -= amount;
        }
      }
    }

    // Already-received cheques still clearing: in the booked balance today,
    // not spendable until their clearing date.
    for (const f of floatHeld) {
      const st = states.get(f.destinationAccountId);
      if (!st) continue;
      const amount = Number(f.amount);
      st.floatDiff[0] += amount;
      st.floatDiff[Math.min(dayIndex(f.clearingDate!), nDays)] -= amount;
    }

    const projections: { projection: AccountProjection; slots: Slot[] }[] = [];
    for (const st of states.values()) {
      if (st.meta.unallocated && st.slots.every((s) => s.inflow === 0 && s.outflow === 0)) continue;
      let book = st.startBook;
      let uncleared = 0;
      const days: AccountProjectionDay[] = [];
      for (let i = 0; i < nDays; i++) {
        const slot = st.slots[i];
        book = round2(book + slot.inflow - slot.outflow);
        uncleared = round2(uncleared + st.floatDiff[i]);
        const available = round2(book - st.reserved - uncleared);
        days.push({
          date: isoDate(addDays(today, i)),
          inflow: round2(slot.inflow),
          outflow: round2(slot.outflow),
          book,
          available,
          liquidity: round2(available + st.meta.overdraftLimit),
        });
      }
      projections.push({ projection: { ...st.meta, days }, slots: st.slots });
    }

    const toList = (m: typeof overduePayables) => Array.from(m.entries()).map(([currencyCode, v]) => ({ currencyCode, ...v }));
    return { today, nDays, projections, overdue: { payables: toList(overduePayables), receivables: toList(overdueReceivables) } };
  },

  // Base-currency rates for whichever currencies appear in the projection.
  // A currency with no obtainable rate is left out (and reported), never
  // guessed - same rule as the consolidated cash position.
  // Base-currency rates for whichever currencies appear in the projection
  // (see fx/base-rates.ts: converted totals are a Pro+ feature; a currency
  // with no obtainable rate is left out and reported, never guessed).
  async ratesToBase(tenantId: string, currencies: string[]) {
    return getRatesToBase(tenantId, currencies);
  },

  async getProjectionDetail(tenantId: string, from: Date, to: Date, filters: { accountId?: string; currencyCode?: string } = {}): Promise<ProjectionDetail> {
    const { today, nDays, projections: built, overdue } = await this.buildProjection(tenantId, to, filters);
    const projections = built.map((b) => b.projection);
    const fromIdx = Math.max(0, diffDays(today, toDateOnly(from) < today ? today : toDateOnly(from)));
    const { base, rates, conversionEnabled } = await this.ratesToBase(tenantId, projections.map((a) => a.currencyCode));

    // With an explicit currency filter everything is one currency - no
    // conversion, totals are in that currency itself.
    const rateFor = (currency: string) => (filters.currencyCode ? 1 : rates[currency]);
    const unconverted = filters.currencyCode ? [] : Array.from(new Set(projections.filter((a) => rates[a.currencyCode] === undefined).map((a) => a.currencyCode)));

    const points: ProjectionPoint[] = [];
    for (let i = fromIdx; i < nDays; i++) {
      let inflow = 0, outflow = 0, available = 0, liquidity = 0;
      const shortfall: string[] = [], overdraft: string[] = [], excess: string[] = [];
      for (const { projection: a, slots } of built) {
        const d = a.days[i];
        if (!a.unallocated) {
          if (d.liquidity < a.minimumBalance) shortfall.push(a.accountName);
          else if (d.available < 0) overdraft.push(a.accountName);
          else if (a.targetBalance > 0 && d.available > a.targetBalance) excess.push(a.accountName);
        }
        const rate = rateFor(a.currencyCode);
        if (rate === undefined) continue;
        // Transfers are internal moves: they change which account holds the
        // cash but not the company total, so they stay out of the headline flows.
        inflow += (d.inflow - slots[i].transferIn) * rate;
        outflow += (d.outflow - slots[i].transferOut) * rate;
        available += d.available * rate;
        liquidity += d.liquidity * rate;
      }
      points.push({
        date: projections[0]?.days[i].date ?? isoDate(addDays(today, i)),
        inflow: round2(inflow),
        outflow: round2(outflow),
        netChange: round2(inflow - outflow),
        projectedBalance: round2(available),
        projectedLiquidity: round2(liquidity),
        shortfallAccounts: shortfall,
        overdraftAccounts: overdraft,
        excessAccounts: excess,
      });
    }

    // No accounts at all: still return an (empty-valued) point per day so
    // callers get a continuous date axis.
    if (projections.length === 0) {
      for (let i = fromIdx; i < nDays; i++) {
        points.push({ date: isoDate(addDays(today, i)), inflow: 0, outflow: 0, netChange: 0, projectedBalance: 0, projectedLiquidity: 0, shortfallAccounts: [], overdraftAccounts: [], excessAccounts: [] });
      }
    }

    return {
      from: isoDate(addDays(today, fromIdx)),
      to: isoDate(addDays(today, nDays - 1)),
      baseCurrency: filters.currencyCode ?? base,
      currencyFilter: filters.currencyCode ?? null,
      points,
      accounts: projections.map((a) => ({ ...a, days: a.days.slice(fromIdx) })),
      unconvertedCurrencies: unconverted,
      fxConversion: conversionEnabled,
      overdue: {
        payables: overdue.payables,
        receivables: overdue.receivables,
      },
    };
  },

  // Company-wide series only - what the Dashboard and the forecast report use.
  async getProjection(tenantId: string, from: Date, to: Date, filters: { accountId?: string; currencyCode?: string } = {}): Promise<ProjectionPoint[]> {
    return (await this.getProjectionDetail(tenantId, from, to, filters)).points;
  },
};
