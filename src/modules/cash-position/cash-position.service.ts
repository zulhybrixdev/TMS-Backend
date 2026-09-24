import { prisma } from "../../common/prisma";
import { computeAccountMetrics, recommendTransfers, DEFAULT_CASH_ENGINE_CONFIG } from "../../treasury-engine/cash-engine.service";
import { getActiveAccountsWithBank, toAccountLike, serializeAccount } from "../bank-accounts/bank-accounts.service";
import { systemSettingsService, SETTING_KEYS } from "../system-settings/system-settings.service";
import { fxService } from "../fx/fx.service";
import { getRatesToBase } from "../fx/base-rates";
import { toDateOnly, todayDateOnly } from "../../common/dates";
import { dailyClosingBalances } from "../treasury-desk/balance-series";

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

    // Headline totals are in the tenant's base currency: adding a USD balance
    // to a MYR one as if they were the same unit gives a meaningless number.
    // A currency with no obtainable rate is left out of the totals and
    // reported in unconvertedCurrencies rather than guessed. Per-currency
    // figures (byCurrency, each account row) stay in their own currency.
    const { base, rates, conversionEnabled } = await getRatesToBase(tenantId, metrics.map((m) => m.currencyCode));
    const foreign = Array.from(new Set(metrics.map((m) => m.currencyCode))).filter((c) => c !== base);
    const unconvertedCurrencies = foreign.filter((c) => rates[c] === undefined);
    const inBase = (pick: (m: (typeof metrics)[number]) => number) => round2(metrics.reduce((s, m) => (rates[m.currencyCode] === undefined ? s : s + pick(m) * rates[m.currencyCode]!), 0));

    const totalCash = inBase((m) => m.currentBalance);
    const availableCash = inBase((m) => m.availableCash);
    const minimumRequired = inBase((m) => m.minimumBalance);
    const targetTotal = inBase((m) => m.targetBalance);
    const totalShortfall = inBase((m) => m.shortfall);
    const totalExcess = inBase((m) => m.excessCash);
    const totalFloat = inBase((m) => m.floatAmount ?? 0);
    const overdraftLimit = inBase((m) => m.overdraftLimit ?? 0);
    const overdraftUtilised = inBase((m) => m.overdraftUtilised);
    const liquidity = inBase((m) => m.liquidity);

    const byBank = groupSum(metrics, (m) => m.bankName, (m) => (rates[m.currencyCode] === undefined ? 0 : m.currentBalance * rates[m.currencyCode]!));
    const byCurrency = groupSum(metrics, (m) => m.currencyCode, (m) => m.currentBalance);

    const config = await this.getEngineConfig(tenantId);
    const recommendations = recommendTransfers(
      accounts.map(toAccountLike),
      config
    );

    return {
      baseCurrency: base,
      fxConversion: conversionEnabled,
      unconvertedCurrencies,
      totalCash,
      availableCash,
      minimumRequired,
      targetTotal,
      excessOverTarget: round2(availableCash - targetTotal),
      totalShortfall,
      totalExcess,
      totalFloat,
      overdraftLimit,
      overdraftUtilised,
      liquidity,
      accountCount: accounts.length,
      accountsInShortfall: metrics.filter((m) => m.status === "SHORTFALL").length,
      byBank,
      byCurrency,
      accounts: accounts.map(serializeAccount),
      recommendations,
    };
  },

  // Daily/weekly/monthly historical view, from the account_balances snapshots
  // (see treasury-desk/balance-series.ts: quiet days carry the last balance
  // forward). Company total in the base currency; a weekly/monthly point is
  // the balance on the last day of that week/month within the range.
  async getHistory(tenantId: string, period: "daily" | "weekly" | "monthly", from: Date, to: Date) {
    const fromDay = toDateOnly(from);
    const toDay = toDateOnly(to) > todayDateOnly() ? todayDateOnly() : toDateOnly(to);
    if (toDay < fromDay) return [];

    const [{ dates, byAccount }, accounts] = await Promise.all([
      dailyClosingBalances(tenantId, fromDay, toDay),
      prisma.bankAccount.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, currencyCode: true } }),
    ]);
    const { rates } = await getRatesToBase(tenantId, accounts.map((a) => a.currencyCode));

    const bucketed = new Map<string, number>();
    dates.forEach((date, i) => {
      let total = 0;
      for (const a of accounts) {
        const v = byAccount.get(a.id)?.[i];
        const rate = rates[a.currencyCode];
        if (v != null && rate !== undefined) total += v * rate;
      }
      bucketed.set(bucketKey(new Date(`${date}T00:00:00Z`), period), round2(total)); // later days overwrite earlier ones: last day of the bucket wins
    });
    return Array.from(bucketed.entries()).map(([date, closingBalance]) => ({ date, closingBalance })).sort((a, b) => a.date.localeCompare(b.date));
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

function groupSum<T>(rows: T[], keyFn: (r: T) => string, valueFn: (r: T) => number) {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(keyFn(r), round2((map.get(keyFn(r)) ?? 0) + valueFn(r)));
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
