import { Decimal } from "@prisma/client/runtime/library";

// ─────────────────────────────────────────────────────────────────────────
// Treasury Cash Engine
//
// Reusable, side-effect-free business logic for cash positioning and
// inter-account transfer recommendations. Kept independent of Express/Prisma
// request handling so it can be unit-tested and reused by the dashboard,
// cash position, and transfer modules alike.
// ─────────────────────────────────────────────────────────────────────────

export interface AccountLike {
  id: string;
  accountName: string;
  bankName: string;
  currencyCode: string;
  currentBalance: number;
  reservedAmount: number;
  minimumBalance: number;
  targetBalance: number;
  /** Approved overdraft facility (0 = none). Balance may go negative down to -overdraftLimit. */
  overdraftLimit?: number;
  /** Cheque float not yet cleared (day 1 + day 2 + later) - booked, but not usable yet. */
  floatAmount?: number;
}

export interface AccountMetrics extends AccountLike {
  /** Current Balance - Reserved - uncleared float. Overdraft headroom is NOT included (see liquidity). */
  availableCash: number;
  /** Portion of the overdraft facility currently drawn (the negative part of the balance). */
  overdraftUtilised: number;
  /** Overdraft facility still undrawn. */
  overdraftAvailable: number;
  /** Everything that could be spent today: available cash plus the overdraft facility. */
  liquidity: number;
  shortfall: number; // Required Balance - Available Cash, floored at 0
  excessCash: number; // Available Cash - Target Balance, floored at 0
  status: "SHORTFALL" | "BELOW_TARGET" | "HEALTHY" | "EXCESS";
}

export interface TransferRecommendation {
  sourceAccountId: string;
  sourceAccountName: string;
  destinationAccountId: string;
  destinationAccountName: string;
  currencyCode: string;
  amount: number;
  reason: string;
}

export interface CashEngineConfig {
  /** Fraction of an account's excess cash that may be swept out in one recommendation (0-1). */
  maxSweepRatio: number;
  /** Currency conversion is out of scope for Phase 1 - only match same-currency accounts. */
  restrictToSameCurrency: boolean;
}

export const DEFAULT_CASH_ENGINE_CONFIG: CashEngineConfig = {
  maxSweepRatio: 1,
  restrictToSameCurrency: true,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNum(v: number | Decimal | string): number {
  return typeof v === "number" ? v : Number(v);
}

/** Available Cash = Current Balance - Reserved Amount - uncleared float */
export function computeAvailableCash(account: Pick<AccountLike, "currentBalance" | "reservedAmount" | "floatAmount">): number {
  return round2(toNum(account.currentBalance) - toNum(account.reservedAmount) - toNum(account.floatAmount ?? 0));
}

/** Overdraft drawn = the negative part of the balance, capped only by reporting (may exceed the limit if the bank allowed it). */
export function computeOverdraftUtilised(account: Pick<AccountLike, "currentBalance">): number {
  return round2(Math.max(0, -toNum(account.currentBalance)));
}

/** Shortfall = Required (minimum) Balance - Available Cash, floored at 0 */
export function computeShortfall(account: Pick<AccountLike, "currentBalance" | "reservedAmount" | "minimumBalance" | "floatAmount">): number {
  const available = computeAvailableCash(account);
  return round2(Math.max(0, toNum(account.minimumBalance) - available));
}

/** Excess Cash = Available Cash - Target Balance, floored at 0 */
export function computeExcessCash(account: Pick<AccountLike, "currentBalance" | "reservedAmount" | "targetBalance" | "floatAmount">): number {
  const available = computeAvailableCash(account);
  return round2(Math.max(0, available - toNum(account.targetBalance)));
}

export function computeAccountMetrics(account: AccountLike): AccountMetrics {
  const availableCash = computeAvailableCash(account);
  const shortfall = computeShortfall(account);
  const excessCash = computeExcessCash(account);
  const overdraftLimit = toNum(account.overdraftLimit ?? 0);
  const overdraftUtilised = computeOverdraftUtilised(account);
  const overdraftAvailable = round2(Math.max(0, overdraftLimit - overdraftUtilised));
  // A drawn overdraft is already the negative part of availableCash, so the
  // whole facility (not just the undrawn part) is added back:
  // e.g. balance -20k on a 100k limit -> 80k spendable.
  const liquidity = round2(availableCash + overdraftLimit);

  let status: AccountMetrics["status"] = "HEALTHY";
  if (shortfall > 0) status = "SHORTFALL";
  else if (excessCash > 0) status = "EXCESS";
  else if (availableCash < toNum(account.targetBalance)) status = "BELOW_TARGET";

  return { ...account, availableCash, overdraftUtilised, overdraftAvailable, liquidity, shortfall, excessCash, status };
}

/**
 * Given a set of accounts, find every account in shortfall and recommend
 * transfers from ranked source accounts with excess cash, without ever
 * pulling a source account below its own minimum balance.
 *
 * Ranking: source accounts are ranked by excess cash (descending) so the
 * healthiest accounts are tapped first. When one source can't fully cover
 * a shortfall, the remainder is split across the next-ranked sources.
 */
export function recommendTransfers(
  accounts: AccountLike[],
  config: CashEngineConfig = DEFAULT_CASH_ENGINE_CONFIG
): TransferRecommendation[] {
  const metrics = accounts.map(computeAccountMetrics);
  const recommendations: TransferRecommendation[] = [];

  // Track remaining excess per source as we allocate across multiple shortfalls.
  const remainingExcess = new Map(metrics.map((m) => [m.id, m.excessCash]));

  const shortfallAccounts = metrics
    .filter((m) => m.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall);

  for (const target of shortfallAccounts) {
    let remainingNeed = target.shortfall;

    const sources = metrics
      .filter(
        (m) =>
          m.id !== target.id &&
          (remainingExcess.get(m.id) ?? 0) > 0 &&
          (!config.restrictToSameCurrency || m.currencyCode === target.currencyCode)
      )
      .sort((a, b) => (remainingExcess.get(b.id) ?? 0) - (remainingExcess.get(a.id) ?? 0));

    for (const source of sources) {
      if (remainingNeed <= 0) break;
      const available = remainingExcess.get(source.id) ?? 0;
      const sweepCap = round2(available * config.maxSweepRatio);
      const amount = round2(Math.min(remainingNeed, sweepCap));
      if (amount <= 0) continue;

      recommendations.push({
        sourceAccountId: source.id,
        sourceAccountName: `${source.accountName}`,
        destinationAccountId: target.id,
        destinationAccountName: `${target.accountName}`,
        currencyCode: target.currencyCode,
        amount,
        reason: `${target.accountName} is below its minimum balance by ${target.shortfall.toLocaleString()} ${target.currencyCode}. ${source.accountName} holds ${source.excessCash.toLocaleString()} ${source.currencyCode} above its target balance.`,
      });

      remainingExcess.set(source.id, round2(available - amount));
      remainingNeed = round2(remainingNeed - amount);
    }
  }

  return recommendations;
}

/**
 * Validate a (possibly Finance-user-modified) transfer amount against the
 * source account so it never drops below the source's minimum balance.
 */
export function validateTransferAmount(
  source: Pick<AccountLike, "currentBalance" | "reservedAmount" | "minimumBalance" | "overdraftLimit" | "floatAmount">,
  amount: number
): { valid: boolean; reason?: string; maxAllowed: number } {
  const available = computeAvailableCash(source);
  // The overdraft facility counts as spendable, so an account with one can
  // fund a transfer by drawing on it (available already nets out anything
  // already drawn, since that is the negative part of the balance).
  const maxAllowed = round2(Math.max(0, available + toNum(source.overdraftLimit ?? 0) - toNum(source.minimumBalance)));

  if (amount <= 0) {
    return { valid: false, reason: "Transfer amount must be greater than zero.", maxAllowed };
  }
  if (amount > maxAllowed) {
    return {
      valid: false,
      reason: `Transfer would bring the source account below its minimum balance. Maximum allowed is ${maxAllowed.toLocaleString()}.`,
      maxAllowed,
    };
  }
  return { valid: true, maxAllowed };
}
