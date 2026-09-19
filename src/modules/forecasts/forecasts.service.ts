import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { getActiveAccountsWithBank, toAccountLike } from "../bank-accounts/bank-accounts.service";
import { computeAvailableCash } from "../../treasury-engine/cash-engine.service";

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

export interface ProjectionPoint {
  date: string;
  inflow: number;
  outflow: number;
  netChange: number;
  projectedBalance: number;
  shortfallAccounts: string[];
  excessAccounts: string[];
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

  async getProjection(tenantId: string, from: Date, to: Date): Promise<ProjectionPoint[]> {
    const accounts = await getActiveAccountsWithBank(tenantId);
    const startingBalance = accounts.reduce((s, a) => s + computeAvailableCash(toAccountLike(a)), 0);

    const [manual, payments, incoming, transfersOut, transfersIn] = await Promise.all([
      prisma.cashForecast.findMany({ where: { tenantId, forecastDate: { gte: from, lte: to } } }),
      prisma.payment.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED", "DRAFT"] }, paymentDate: { gte: from, lte: to }, deletedAt: null } }),
      prisma.incomingTransaction.findMany({ where: { tenantId, status: "EXPECTED", valueDate: { gte: from, lte: to } } }),
      prisma.transfer.findMany({ where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED", "DRAFT"] }, transferDate: { gte: from, lte: to } } }),
      Promise.resolve([]), // transfers counted once below (both legs derived from the same rows)
    ]);

    const byDay = new Map<string, { inflow: number; outflow: number }>();
    const bump = (date: Date, field: "inflow" | "outflow", amount: number) => {
      const key = date.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { inflow: 0, outflow: 0 };
      entry[field] += amount;
      byDay.set(key, entry);
    };

    for (const m of manual) bump(m.forecastDate, m.category === "INFLOW" ? "inflow" : "outflow", Number(m.amount));
    for (const p of payments) bump(p.paymentDate, "outflow", Number(p.amount));
    for (const i of incoming) bump(i.valueDate, "inflow", Number(i.amount));
    for (const t of transfersOut) {
      bump(t.transferDate, "outflow", Number(t.amount));
      bump(t.transferDate, "inflow", Number(t.amount)); // net-zero across the company, still visible per leg on Cash Position by account
    }

    const days: ProjectionPoint[] = [];
    let running = startingBalance;
    const cursor = new Date(from);
    while (cursor <= to) {
      const key = cursor.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { inflow: 0, outflow: 0 };
      const netChange = round2(entry.inflow - entry.outflow);
      running = round2(running + netChange);
      days.push({
        date: key,
        inflow: round2(entry.inflow),
        outflow: round2(entry.outflow),
        netChange,
        projectedBalance: running,
        shortfallAccounts: [],
        excessAccounts: [],
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return days;
  },
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
