import { prisma } from "../../common/prisma";
import { PLAN_KEYS, MODULE_KEYS, PlanKeyValue, planIncludesModule } from "../../common/plans";
import { systemSettingsService, SETTING_KEYS } from "../system-settings/system-settings.service";
import { fxService } from "./fx.service";

export interface BaseRates {
  base: string;
  /** rate = units of base per 1 unit of the currency; undefined = not convertible. */
  rates: Record<string, number | undefined>;
  /** False when the tenant's plan doesn't include converted totals (Pro+ only). */
  conversionEnabled: boolean;
}

// Rates for turning company totals into the tenant's base currency.
//
// Adding balances in different currencies is only meaningful once they are
// converted, and live FX conversion is a Pro+ feature (MODULE_KEYS.
// ADVANCED_INSIGHTS - "consolidated cash position"). On other plans only
// base-currency accounts are totalled; every other currency stays visible
// per account and per currency but is left out of the headline totals
// (reported as unconverted) - never added in raw as if it were the same unit.
export async function getRatesToBase(tenantId: string, currencies: string[], opts: { impersonating?: boolean } = {}): Promise<BaseRates> {
  const [base, subscription] = await Promise.all([
    systemSettingsService.get(tenantId, SETTING_KEYS.BASE_CURRENCY).then((b) => b ?? "MYR"),
    prisma.subscription.findUnique({ where: { tenantId }, select: { planKey: true } }),
  ]);
  const planKey = (subscription?.planKey ?? PLAN_KEYS.FREE) as PlanKeyValue;
  const conversionEnabled = !!opts.impersonating || planIncludesModule(planKey, MODULE_KEYS.ADVANCED_INSIGHTS);

  const rates: Record<string, number | undefined> = { [base]: 1 };
  if (conversionEnabled) {
    const foreign = Array.from(new Set(currencies)).filter((c) => c !== base);
    const entries = await Promise.all(foreign.map(async (c) => [c, await fxService.convert(1, c, base).catch(() => undefined)] as const));
    Object.assign(rates, Object.fromEntries(entries));
  }
  return { base, rates, conversionEnabled };
}
