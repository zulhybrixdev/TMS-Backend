import { prisma } from "../../common/prisma";
import { toCsv, CsvColumn } from "../../common/csv";
import { getActiveAccountsWithBank, toAccountLike } from "../bank-accounts/bank-accounts.service";
import { computeAccountMetrics, AccountMetrics } from "../../treasury-engine/cash-engine.service";
import { forecastsService, ProjectionPoint } from "../forecasts/forecasts.service";
import { addDays, diffDays, isoDate, localDayRange, toDateOnly, todayDateOnly } from "../../common/dates";
import { dailyClosingBalances } from "../treasury-desk/balance-series";
import { bankerAcceptancesService } from "../banker-acceptances/banker-acceptances.service";

// Column definitions are exported alongside each report so reports.routes.ts
// can feed the exact same shape into toXlsxBuffer() for the .xlsx download -
// one source of truth for "what's in this report" per format.
export const CASH_POSITION_COLUMNS: CsvColumn<AccountMetrics>[] = [
  { header: "Bank", value: (r) => r.bankName },
  { header: "Account", value: (r) => r.accountName },
  { header: "Currency", value: (r) => r.currencyCode },
  { header: "Current Balance", value: (r) => r.currentBalance },
  { header: "Available Cash", value: (r) => r.availableCash },
  { header: "Minimum Balance", value: (r) => r.minimumBalance },
  { header: "Target Balance", value: (r) => r.targetBalance },
  { header: "Shortfall", value: (r) => r.shortfall },
  { header: "Excess", value: (r) => r.excessCash },
  { header: "Status", value: (r) => r.status },
];

export const BANK_BALANCES_COLUMNS: CsvColumn<any>[] = [
  { header: "Bank", value: (r: any) => r.bank.name },
  { header: "Account", value: (r: any) => r.accountName },
  { header: "Account Number", value: (r: any) => r.accountNumber },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Current Balance", value: (r: any) => Number(r.currentBalance) },
  { header: "Overdraft Limit", value: (r: any) => Number(r.overdraftLimit) },
  { header: "Overdraft Utilised", value: (r: any) => Math.max(0, -Number(r.currentBalance)) },
  { header: "Site", value: (r: any) => r.siteName ?? "" },
  { header: "Status", value: (r: any) => r.status },
  { header: "Last Updated", value: (r: any) => r.lastBalanceAt?.toISOString() ?? "" },
];

export const PAYMENTS_COLUMNS: CsvColumn<any>[] = [
  { header: "Payment #", value: (r: any) => r.paymentNumber },
  { header: "Beneficiary", value: (r: any) => r.beneficiaryName },
  { header: "Amount", value: (r: any) => Number(r.amount) },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Method", value: (r: any) => r.paymentMethod },
  { header: "Invoice #", value: (r: any) => r.invoiceNumber ?? "" },
  { header: "Source Account", value: (r: any) => r.sourceAccount?.accountName },
  { header: "Due / Payment Date", value: (r: any) => r.paymentDate.toISOString().slice(0, 10) },
  { header: "Status", value: (r: any) => r.status },
  { header: "Requested By", value: (r: any) => r.requestedBy?.name },
];

export const INCOMING_COLUMNS: CsvColumn<any>[] = [
  { header: "Reference", value: (r: any) => r.reference },
  { header: "Source", value: (r: any) => r.sourceName },
  { header: "Amount", value: (r: any) => Number(r.amount) },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Destination Account", value: (r: any) => r.destinationAccount?.accountName },
  { header: "Invoice #", value: (r: any) => r.invoiceNumber ?? "" },
  { header: "Due / Value Date", value: (r: any) => r.valueDate.toISOString().slice(0, 10) },
  { header: "Float Days", value: (r: any) => r.floatDays },
  { header: "Clearing Date", value: (r: any) => r.clearingDate?.toISOString().slice(0, 10) ?? "" },
  { header: "Status", value: (r: any) => r.status },
];

export const TRANSFERS_COLUMNS: CsvColumn<any>[] = [
  { header: "Transfer #", value: (r: any) => r.transferNumber },
  { header: "Source Account", value: (r: any) => r.sourceAccount?.accountName },
  { header: "Destination Account", value: (r: any) => r.destinationAccount?.accountName },
  { header: "Amount", value: (r: any) => Number(r.amount) },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Transfer Date", value: (r: any) => r.transferDate.toISOString().slice(0, 10) },
  { header: "Status", value: (r: any) => r.status },
  { header: "System Recommended", value: (r: any) => (r.isSystemRecommended ? "Yes" : "No") },
];

export const FORECAST_COLUMNS: CsvColumn<ProjectionPoint>[] = [
  { header: "Date", value: (r) => r.date },
  { header: "Inflow", value: (r) => r.inflow },
  { header: "Outflow", value: (r) => r.outflow },
  { header: "Net Change", value: (r) => r.netChange },
  { header: "Projected Balance", value: (r) => r.projectedBalance },
  { header: "Projected Balance incl. Overdraft", value: (r) => r.projectedLiquidity },
];

export const BANKER_ACCEPTANCES_COLUMNS: CsvColumn<any>[] = [
  { header: "Reference", value: (r: any) => r.referenceNo },
  { header: "Credited Account", value: (r: any) => r.creditAccountName },
  { header: "Bank", value: (r: any) => r.creditBankName },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Face Amount", value: (r: any) => r.faceAmount },
  { header: "Proceeds Credited", value: (r: any) => r.proceedsAmount },
  { header: "Discount / Cost", value: (r: any) => r.discountAmount },
  { header: "Effective Rate % p.a.", value: (r: any) => r.effectiveRatePa },
  { header: "Drawdown Date", value: (r: any) => r.drawdownDate.toISOString().slice(0, 10) },
  { header: "Maturity Date", value: (r: any) => r.maturityDate.toISOString().slice(0, 10) },
  { header: "Tenor (days)", value: (r: any) => r.tenorDays },
  { header: "Settlement Account", value: (r: any) => r.settlementAccountName },
  { header: "Status", value: (r: any) => r.status },
  { header: "Settled Date", value: (r: any) => r.settledDate?.toISOString().slice(0, 10) ?? "" },
  { header: "Settled Amount", value: (r: any) => r.settledAmount ?? "" },
];

export interface DailyMovementRow {
  date: string;
  bank: string;
  account: string;
  currency: string;
  opening: number | null;
  collections: number;
  baDrawdown: number;
  baSettlement: number;
  paymentsOut: number;
  transfersIn: number;
  transfersOut: number;
  other: number;
  closing: number | null;
}

export const DAILY_MOVEMENTS_COLUMNS: CsvColumn<DailyMovementRow>[] = [
  { header: "Date", value: (r) => r.date },
  { header: "Bank", value: (r) => r.bank },
  { header: "Account", value: (r) => r.account },
  { header: "Currency", value: (r) => r.currency },
  { header: "Opening Balance", value: (r) => r.opening ?? "" },
  { header: "Collections", value: (r) => r.collections },
  { header: "BA Drawdown (credited)", value: (r) => r.baDrawdown },
  { header: "BA Settlement (debit)", value: (r) => r.baSettlement },
  { header: "Payments", value: (r) => r.paymentsOut },
  { header: "Transfers In", value: (r) => r.transfersIn },
  { header: "Transfers Out", value: (r) => r.transfersOut },
  { header: "Other / Adjustments", value: (r) => r.other },
  { header: "Closing Balance", value: (r) => r.closing ?? "" },
];

// Treasury Service: report datasets shared by the Reports screen (JSON for
// on-screen tables/charts, CSV/XLSX for export).
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export const reportsService = {
  async cashPosition(tenantId: string) {
    const accounts = await getActiveAccountsWithBank(tenantId);
    return accounts.map((a) => computeAccountMetrics(toAccountLike(a)));
  },
  cashPositionCsv(rows: AccountMetrics[]) {
    return toCsv(rows, CASH_POSITION_COLUMNS);
  },

  async bankBalances(tenantId: string) {
    return prisma.bankAccount.findMany({ where: { tenantId, deletedAt: null }, include: { bank: true, currency: true }, orderBy: { accountName: "asc" } });
  },
  bankBalancesCsv(rows: any[]) {
    return toCsv(rows, BANK_BALANCES_COLUMNS);
  },

  async payments(tenantId: string, from?: Date, to?: Date) {
    return prisma.payment.findMany({
      where: { tenantId, deletedAt: null, ...(from || to ? { paymentDate: { gte: from, lte: to } } : {}) },
      include: { sourceAccount: { include: { bank: true } }, requestedBy: { select: { name: true } } },
      orderBy: { paymentDate: "desc" },
    });
  },
  paymentsCsv(rows: any[]) {
    return toCsv(rows, PAYMENTS_COLUMNS);
  },

  async incoming(tenantId: string, from?: Date, to?: Date) {
    return prisma.incomingTransaction.findMany({
      where: { tenantId, ...(from || to ? { valueDate: { gte: from, lte: to } } : {}) },
      include: { destinationAccount: { include: { bank: true } } },
      orderBy: { valueDate: "desc" },
    });
  },
  incomingCsv(rows: any[]) {
    return toCsv(rows, INCOMING_COLUMNS);
  },

  async transfers(tenantId: string, from?: Date, to?: Date) {
    return prisma.transfer.findMany({
      where: { tenantId, ...(from || to ? { transferDate: { gte: from, lte: to } } : {}) },
      include: { sourceAccount: { include: { bank: true } }, destinationAccount: { include: { bank: true } } },
      orderBy: { transferDate: "desc" },
    });
  },
  transfersCsv(rows: any[]) {
    return toCsv(rows, TRANSFERS_COLUMNS);
  },

  async bankerAcceptances(tenantId: string) {
    const { items } = await bankerAcceptancesService.list(tenantId, { page: 1, pageSize: 5000, skip: 0, take: 5000, sortBy: "maturityDate", sortDir: "asc", search: undefined } as any, {});
    return items;
  },
  bankerAcceptancesCsv(rows: any[]) {
    return toCsv(rows, BANKER_ACCEPTANCES_COLUMNS);
  },

  // Every account, every day in the range: opening, each kind of movement,
  // closing. Days with no movement still get a row (the closing balance
  // carried forward), so it doubles as the "daily bank balance" tabulation.
  async dailyMovements(tenantId: string, fromIn: Date, toIn: Date): Promise<DailyMovementRow[]> {
    const today = todayDateOnly();
    const to = toDateOnly(toIn) > today ? today : toDateOnly(toIn);
    let from = toDateOnly(fromIn);
    if (diffDays(from, to) > 92) from = addDays(to, -92); // keep the report (and the ledger scan) bounded
    if (to < from) return [];

    const [accounts, ledger, series] = await Promise.all([
      prisma.bankAccount.findMany({ where: { tenantId, deletedAt: null }, include: { bank: true }, orderBy: [{ bankId: "asc" }, { accountName: "asc" }] }),
      prisma.transaction.findMany({
        where: { tenantId, transactionDate: { gte: localDayRange(from).start, lt: localDayRange(to).end } },
        select: { accountId: true, type: true, amount: true, transactionDate: true },
      }),
      dailyClosingBalances(tenantId, addDays(from, -1), to),
    ]);

    const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const moves = new Map<string, Omit<DailyMovementRow, "date" | "bank" | "account" | "currency" | "opening" | "closing">>();
    for (const t of ledger) {
      const key = `${t.accountId}|${localKey(t.transactionDate)}`;
      const m = moves.get(key) ?? { collections: 0, baDrawdown: 0, baSettlement: 0, paymentsOut: 0, transfersIn: 0, transfersOut: 0, other: 0 };
      const amount = Number(t.amount);
      if (t.type === "INCOMING_IN") m.collections += amount;
      else if (t.type === "BA_DRAWDOWN") m.baDrawdown += amount;
      else if (t.type === "BA_SETTLEMENT") m.baSettlement += amount;
      else if (t.type === "PAYMENT_OUT") m.paymentsOut += amount;
      else if (t.type === "TRANSFER_IN") m.transfersIn += amount;
      else if (t.type === "TRANSFER_OUT") m.transfersOut += amount;
      else m.other += amount;
      moves.set(key, m);
    }

    const rows: DailyMovementRow[] = [];
    for (let i = 0; i <= diffDays(from, to); i++) {
      const date = isoDate(addDays(from, i));
      for (const a of accounts) {
        const closingSeries = series.byAccount.get(a.id) ?? [];
        const closing = closingSeries[i + 1] ?? null; // series starts a day before `from`
        const opening = closingSeries[i] ?? null;
        const m = moves.get(`${a.id}|${date}`) ?? { collections: 0, baDrawdown: 0, baSettlement: 0, paymentsOut: 0, transfersIn: 0, transfersOut: 0, other: 0 };
        const explained = m.collections + m.baDrawdown + m.transfersIn + m.other - m.baSettlement - m.paymentsOut - m.transfersOut;
        // Anything that moved the balance without a ledger entry (a manual
        // statement correction) shows up as "other" so the row always adds up.
        const unexplained = closing !== null && opening !== null ? closing - opening - explained : 0;
        rows.push({
          date,
          bank: a.bank?.name ?? "",
          account: a.accountName,
          currency: a.currencyCode,
          opening,
          collections: round2(m.collections),
          baDrawdown: round2(m.baDrawdown),
          baSettlement: round2(m.baSettlement),
          paymentsOut: round2(m.paymentsOut),
          transfersIn: round2(m.transfersIn),
          transfersOut: round2(m.transfersOut),
          other: round2(m.other + unexplained),
          closing,
        });
      }
    }
    return rows;
  },
  dailyMovementsCsv(rows: DailyMovementRow[]) {
    return toCsv(rows, DAILY_MOVEMENTS_COLUMNS);
  },

  async cashFlow(tenantId: string, from: Date, to: Date) {
    const [outIn, outOut, inIn] = await Promise.all([
      prisma.transaction.groupBy({ by: ["type"], where: { tenantId, transactionDate: { gte: from, lte: to } }, _sum: { amount: true } }),
      Promise.resolve(null),
      Promise.resolve(null),
    ]);
    return outIn.map((r) => ({ type: r.type, total: Number(r._sum.amount ?? 0) }));
  },

  async forecast(tenantId: string, from: Date, to: Date) {
    return forecastsService.getProjection(tenantId, from, to);
  },
  forecastCsv(rows: ProjectionPoint[]) {
    return toCsv(rows, FORECAST_COLUMNS);
  },

  async audit(tenantId: string, from?: Date, to?: Date) {
    return prisma.auditLog.findMany({
      where: { tenantId, ...(from || to ? { createdAt: { gte: from, lte: to } } : {}) },
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
  },
  auditCsv(rows: any[]) {
    return toCsv(rows, [
      { header: "Date", value: (r) => r.createdAt.toISOString() },
      { header: "Actor", value: (r) => r.actor?.name ?? "System" },
      { header: "Action", value: (r) => r.action },
      { header: "Entity Type", value: (r) => r.entityType },
      { header: "Entity Id", value: (r) => r.entityId },
    ]);
  },
};

// Custom report builder registry (Pro+, see report-definitions.service.ts):
// one entry per "base report" a saved definition can be built on, reusing
// the exact same fetch + column definitions the built-in report already
// uses - a custom report is just a caller-chosen subset/order of an
// existing report's columns, never a new data-access path.
export const BASE_REPORTS: Record<string, { label: string; columns: CsvColumn<any>[]; fetch: (tenantId: string, from?: Date, to?: Date) => Promise<any[]> }> = {
  "cash-position": { label: "Cash Position", columns: CASH_POSITION_COLUMNS, fetch: (t) => reportsService.cashPosition(t) },
  "bank-balances": { label: "Bank Balances", columns: BANK_BALANCES_COLUMNS, fetch: (t) => reportsService.bankBalances(t) },
  payments: { label: "Payments", columns: PAYMENTS_COLUMNS, fetch: (t, from, to) => reportsService.payments(t, from, to) },
  incoming: { label: "Incoming Transactions", columns: INCOMING_COLUMNS, fetch: (t, from, to) => reportsService.incoming(t, from, to) },
  transfers: { label: "Transfers", columns: TRANSFERS_COLUMNS, fetch: (t, from, to) => reportsService.transfers(t, from, to) },
  "banker-acceptances": { label: "Banker Acceptances", columns: BANKER_ACCEPTANCES_COLUMNS, fetch: (t) => reportsService.bankerAcceptances(t) },
  "daily-movements": { label: "Daily Bank Movements & Balances", columns: DAILY_MOVEMENTS_COLUMNS, fetch: (t, from, to) => reportsService.dailyMovements(t, from ?? addDays(todayDateOnly(), -30), to ?? todayDateOnly()) },
  forecast: { label: "Forecast", columns: FORECAST_COLUMNS, fetch: (t, from, to) => reportsService.forecast(t, from ?? todayDateOnly(), to ?? addDays(todayDateOnly(), 30)) },
};
