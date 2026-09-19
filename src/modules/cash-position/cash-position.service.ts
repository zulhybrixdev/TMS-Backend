import { prisma } from "../../common/prisma";
import { computeAccountMetrics, recommendTransfers, DEFAULT_CASH_ENGINE_CONFIG } from "../../treasury-engine/cash-engine.service";
import { getActiveAccountsWithBank, toAccountLike, serializeAccount } from "../bank-accounts/bank-accounts.service";
import { systemSettingsService, SETTING_KEYS } from "../system-settings/system-settings.service";
import { fxService } from "../fx/fx.service";

// Treasury Service: consolidated cash position. This is the shared
// aggregation layer behind both the Dashboard and the dedicated Cash
// Position screen.
export const cashPositionService = {
  async getEngineConfig(tenantId: string) {
    return {
      maxSweepRatio: await systemSettingsService.getNumber(tenantId, SETTING_KEYS.MAX_SWEEP_RATIO).then((n) => (n > 0 ? n : DEFAULT_CASH_ENGINE_CONFIG.maxSweepRatio)),
      restrictToSameCurrency: await systemSettingsService.getBool(tenantId, SETTING_KEYS.RESTRICT_TRANSFERS_TO_SAME_CURRENCY),
    };
  },

  async getSummary(tenantId: string) {
    const accounts = await getActiveAccountsWithBank(tenantId);
    const metrics = accounts.map((a) => computeAccountMetrics(toAccountLike(a)));

    const totalCash = round2(metrics.reduce((s, m) => s + m.currentBalance, 0));
    const availableCash = round2(metrics.reduce((s, m) => s + m.availableCash, 0));
    const minimumRequired = round2(metrics.reduce((s, m) => s + m.minimumBalance, 0));
    const targetTotal = round2(metrics.reduce((s, m) => s + m.targetBalance, 0));
    const totalShortfall = round2(metrics.reduce((s, m) => s + m.shortfall, 0));
    const totalExcess = round2(metrics.reduce((s, m) => s + m.excessCash, 0));

    const byBank = groupSum(metrics, (m) => m.bankName);
    const byCurrency = groupSum(metrics, (m) => m.currencyCode);

    const config = await this.getEngineConfig(tenantId);
    const recommendations = recommendTransfers(
      accounts.map(toAccountLike),
      config
    );

    return {
      totalCash,
      availableCash,
      minimumRequired,
      targetTotal,
      excessOverTarget: round2(availableCash - targetTotal),
      totalShortfall,
      totalExcess,
      accountCount: accounts.length,
      accountsInShortfall: metrics.filter((m) => m.status === "SHORTFALL").length,
      byBank,
      byCurrency,
      accounts: accounts.map(serializeAccount),
      recommendations,
    };
  },

  // Daily/weekly/monthly historical view built from the account_balances
  // snapshot table (populated by manual entry and by every ledger posting).
  async getHistory(tenantId: string, period: "daily" | "weekly" | "monthly", from: Date, to: Date) {
    const rows = await prisma.accountBalance.findMany({
      where: { tenantId, balanceDate: { gte: from, lte: to } },
      include: { account: { include: { bank: true } } },
      orderBy: { balanceDate: "asc" },
    });

    const bucketed = new Map<string, { date: string; closingBalance: number }>();
    for (const row of rows) {
      const key = bucketKey(row.balanceDate, period);
      const existing = bucketed.get(key);
      const value = Number(row.closingBalance);
      if (!existing) bucketed.set(key, { date: key, closingBalance: value });
      else existing.closingBalance += value; // sum across accounts for that bucket's last known day
    }

    return Array.from(bucketed.values()).sort((a, b) => a.date.localeCompare(b.date));
  },

  // Consolidated, FX-converted total - Pro+ only (MODULE_KEYS.ADVANCED_INSIGHTS,
  // see fx.routes.ts/cash-position.routes.ts). Every plan already sees
  // per-currency balances side-by-side (getSummary().byCurrency, per the
  // Phase 1 "no FX conversion" assumption) - this is the one place that
  // assumption is relaxed, using live rates from fx.service.ts.
  async getConsolidated(tenantId: string) {
    const [{ byCurrency }, baseCurrency] = await Promise.all([this.getSummary(tenantId), systemSettingsService.get(tenantId, SETTING_KEYS.BASE_CURRENCY)]);
    const base = baseCurrency ?? "MYR";

    // fxService.convert(amount, from, to) is "1 unit of `from` = X `to`" -
    // the foreign currency has to be the `from` and the tenant's base the
    // `to`, not the other way round. Getting this backwards silently
    // divides instead of multiplies (e.g. mixing up MYR-per-USD with
    // USD-per-MYR), so each foreign currency's rate is looked up the same
    // direction convert() itself uses, rather than one batched call from
    // the tenant's base.
    const foreignCurrencies = byCurrency.map((c) => c.key).filter((c) => c !== base);
    const rateEntries = await Promise.all(
      foreignCurrencies.map(async (currency) => [currency, await fxService.convert(1, currency, base).catch(() => undefined)] as const)
    );
    const ratesToBase = Object.fromEntries(rateEntries);

    const breakdown = byCurrency.map((c) => {
      const rate = c.key === base ? 1 : ratesToBase[c.key];
      return {
        currencyCode: c.key,
        total: c.total,
        rateToBase: rate ?? null,
        totalInBase: rate !== undefined ? round2(c.total * rate) : null,
      };
    });

    const totalInBase = round2(breakdown.reduce((sum, b) => sum + (b.totalInBase ?? 0), 0));
    const unconverted = breakdown.filter((b) => b.totalInBase === null).map((b) => b.currencyCode);

    return { baseCurrency: base, totalInBase, breakdown, unconvertedCurrencies: unconverted };
  },
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function groupSum<T extends { currentBalance: number }>(rows: T[], keyFn: (r: T) => string) {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(keyFn(r), round2((map.get(keyFn(r)) ?? 0) + r.currentBalance));
  }
  return Array.from(map.entries()).map(([key, total]) => ({ key, total }));
}

function bucketKey(date: Date, period: "daily" | "weekly" | "monthly"): string {
  const d = new Date(date);
  if (period === "monthly") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  if (period === "weekly") {
    const firstJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - firstJan.getTime()) / 86400000 + firstJan.getUTCDay() + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return d.toISOString().slice(0, 10);
}
