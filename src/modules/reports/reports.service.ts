import { prisma } from "../../common/prisma";
import { toCsv, CsvColumn } from "../../common/csv";
import { getActiveAccountsWithBank, toAccountLike } from "../bank-accounts/bank-accounts.service";
import { computeAccountMetrics, AccountMetrics } from "../../treasury-engine/cash-engine.service";
import { forecastsService, ProjectionPoint } from "../forecasts/forecasts.service";

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
  { header: "Status", value: (r: any) => r.status },
  { header: "Last Updated", value: (r: any) => r.lastBalanceAt?.toISOString() ?? "" },
];

export const PAYMENTS_COLUMNS: CsvColumn<any>[] = [
  { header: "Payment #", value: (r: any) => r.paymentNumber },
  { header: "Beneficiary", value: (r: any) => r.beneficiaryName },
  { header: "Amount", value: (r: any) => Number(r.amount) },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Source Account", value: (r: any) => r.sourceAccount?.accountName },
  { header: "Payment Date", value: (r: any) => r.paymentDate.toISOString().slice(0, 10) },
  { header: "Status", value: (r: any) => r.status },
  { header: "Requested By", value: (r: any) => r.requestedBy?.name },
];

export const INCOMING_COLUMNS: CsvColumn<any>[] = [
  { header: "Reference", value: (r: any) => r.reference },
  { header: "Source", value: (r: any) => r.sourceName },
  { header: "Amount", value: (r: any) => Number(r.amount) },
  { header: "Currency", value: (r: any) => r.currencyCode },
  { header: "Destination Account", value: (r: any) => r.destinationAccount?.accountName },
  { header: "Value Date", value: (r: any) => r.valueDate.toISOString().slice(0, 10) },
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
];

// Treasury Service: report datasets shared by the Reports screen (JSON for
// on-screen tables/charts, CSV/XLSX for export).
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
  forecast: { label: "Forecast", columns: FORECAST_COLUMNS, fetch: (t, from, to) => reportsService.forecast(t, from ?? new Date(), to ?? new Date(Date.now() + 30 * 86400000)) },
};
