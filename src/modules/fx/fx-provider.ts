// Provider abstraction so swapping the live FX source later (a paid
// intraday feed, a client-provided treasury rate source, etc.) never
// touches fx.service.ts or its callers - only a new class here.
export interface FxRateResult {
  base: string;
  quote: string;
  rate: number;
  date: string; // YYYY-MM-DD
  // Present for intraday providers (TwelveDataFxProvider) - when this
  // specific quote was captured, for an honest "as of HH:MM" label rather
  // than implying tick-level freshness. Absent for daily providers
  // (Frankfurter) where `date` alone is the right granularity.
  fetchedAt?: Date;
}

export interface FxProvider {
  getRates(base: string, quotes: string[]): Promise<FxRateResult[]>;
}

// Frankfurter (https://frankfurter.dev) - free, no API key/account, backed
// by ECB (and, per its docs, BNM among other central banks') daily
// reference rates. Verified against the live API directly (not taken on
// faith from docs): v2's real shape is `GET /v2/rates?base=X&quotes=Y,Z`
// returning an array of {date,base,quote,rate} objects, and the `quotes`
// query param specifically (not `symbols`, which the v1 API used and 422s
// on v2). This is daily reference-rate data, not live/intraday trading FX
// - fine for a treasury POC's consolidated-view conversion, not for
// anything that needs bid/ask spreads or tick data.
export class FrankfurterFxProvider implements FxProvider {
  private readonly baseUrl = "https://api.frankfurter.dev/v2";

  async getRates(base: string, quotes: string[]): Promise<FxRateResult[]> {
    if (quotes.length === 0) return [];
    const url = `${this.baseUrl}/rates?base=${encodeURIComponent(base)}&quotes=${quotes.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Frankfurter FX API error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { date: string; base: string; quote: string; rate: number }[];
    return data.map((r) => ({ base: r.base, quote: r.quote, rate: r.rate, date: r.date }));
  }
}

// Twelve Data (https://twelvedata.com) - real intraday/live market quotes,
// unlike Frankfurter's daily reference rates. Verified directly against
// the live API with the provided key before building against it: the
// batched `/price?symbol=A/B,C/D` endpoint returns `{"A/B":{"price":".."},
// ...}` for 2+ symbols but a bare `{"price":".."}` (no symbol wrapper) for
// exactly 1 - handled explicitly below rather than assumed. An unknown/
// invalid symbol is a real HTTP 404 with a `{status:"error"}` body, not a
// 200 with an error buried in it.
//
// Deliberately NOT exported. Free "basic" plan constraints (confirmed via
// `/api_usage`): 8 credits/minute, 800/day, shared account-wide across
// every process using this key. That budget is enforced by
// createTwelveDataProvider() below, in this same file, wrapping this raw
// class - so there is no exported way to call Twelve Data that skips the
// budget check, not just a convention that callers are expected to follow.
// If you're looking for "the Twelve Data provider" to use elsewhere,
// that's createTwelveDataProvider(), not this.
class RawTwelveDataFxProvider implements FxProvider {
  private readonly baseUrl = "https://api.twelvedata.com";
  constructor(private readonly apiKey: string) {}

  async getRates(base: string, quotes: string[]): Promise<FxRateResult[]> {
    if (quotes.length === 0) return [];
    const symbols = quotes.map((q) => `${base}/${q}`);
    const url = `${this.baseUrl}/price?symbol=${encodeURIComponent(symbols.join(","))}&apikey=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => null)) as ({ status?: string; message?: string; price?: string } & Record<string, { price: string }>) | null;

    if (!res.ok || body?.status === "error") {
      throw new Error(`Twelve Data FX API error ${res.status}: ${body?.message ?? "unknown error"}`);
    }

    const fetchedAt = new Date();
    const dateStr = fetchedAt.toISOString().slice(0, 10);

    // Single-symbol responses aren't wrapped by symbol key - normalise to
    // the same shape as the multi-symbol case before mapping.
    const bySymbol: Record<string, { price: string }> = quotes.length === 1 ? { [symbols[0]]: { price: body!.price! } } : (body as Record<string, { price: string }>);

    return quotes.map((quote, i) => {
      const entry = bySymbol[symbols[i]];
      if (!entry?.price) throw new Error(`Twelve Data returned no price for ${symbols[i]}`);
      return { base, quote, rate: Number(entry.price), date: dateStr, fetchedAt };
    });
  }
}

// Hard daily credit ceiling, enforced here (not in fx.service.ts) so it
// can't be reached around. The same TWELVEDATA_API_KEY is shared by all
// three backend tiers (dev/uat/prod), each a separate process with its own
// in-memory counter that can't see the others' usage - Twelve Data's
// 800/day cap is per key, i.e. account-wide, not per process. Default
// below is deliberately 250 (not ~800), a three-way split with headroom,
// so all three tiers maxing out simultaneously (250 x 3 = 750) still can't
// exceed the real limit. Raise TWELVEDATA_DAILY_BUDGET per-tier only if
// you know the others won't be pulling live rates at the same time.
//
// In-memory, resets on process restart (not just at UTC midnight) - a real
// production deployment sharing one key across processes would move this
// to a shared store (Redis, a DB row) so a restart mid-day can't reset the
// count while real daily usage elsewhere on the same key hasn't.
const TWELVEDATA_DAILY_BUDGET = Number(process.env.TWELVEDATA_DAILY_BUDGET ?? 250);
let creditsUsedToday = 0;
let creditsResetDate = new Date().toISOString().slice(0, 10);

function reserveCredits(count: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== creditsResetDate) {
    creditsResetDate = today;
    creditsUsedToday = 0;
  }
  if (creditsUsedToday + count > TWELVEDATA_DAILY_BUDGET) return false;
  creditsUsedToday += count;
  return true;
}

// The only supported way to get a Twelve Data-backed FxProvider - every
// getRates() call it returns is budget-checked first. Callers can't
// reasonably tell "budget exhausted" apart from any other provider
// failure (both just throw), which is intentional: fx.service.ts already
// treats every Twelve Data failure the same way, by falling back to the
// daily reference rate.
export function createTwelveDataProvider(apiKey: string): FxProvider {
  const raw = new RawTwelveDataFxProvider(apiKey);
  return {
    async getRates(base, quotes) {
      if (!reserveCredits(quotes.length)) {
        throw new Error(`Twelve Data daily budget (${TWELVEDATA_DAILY_BUDGET}) reached for this process - resets tomorrow (UTC) or on restart.`);
      }
      return raw.getRates(base, quotes);
    },
  };
}

// Transparency into the guardrail above, for the /fx/live-rates/usage
// route - lets the UI show "X/250 used today" instead of the budget being
// an invisible, silent fallback.
export function getTwelveDataUsage(): { creditsUsedToday: number; creditsBudget: number; creditsRemaining: number } {
  const today = new Date().toISOString().slice(0, 10);
  const used = today === creditsResetDate ? creditsUsedToday : 0;
  return { creditsUsedToday: used, creditsBudget: TWELVEDATA_DAILY_BUDGET, creditsRemaining: Math.max(0, TWELVEDATA_DAILY_BUDGET - used) };
}
