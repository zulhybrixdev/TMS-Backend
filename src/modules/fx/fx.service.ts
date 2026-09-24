import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { FrankfurterFxProvider, FxProvider, createTwelveDataProvider, getTwelveDataUsage } from "./fx-provider";

const provider: FxProvider = new FrankfurterFxProvider();
// createTwelveDataProvider() (not the raw class - there is no exported raw
// class) returns a provider whose getRates() is already budget-checked -
// see fx-provider.ts for why that enforcement lives there instead of here.
const liveProvider = env.twelveDataApiKey ? createTwelveDataProvider(env.twelveDataApiKey) : null;

// In-memory only (not fx_rates - that table is daily-granularity by
// design, see rateDate @db.Date). 10 minutes is deliberately generous, not
// "as live as possible" - Twelve Data's free plan is 800 credits/day; at
// 1 credit/symbol, caching every distinct (base, quotes) combination for
// 10 minutes keeps a handful of currency pairs, polled continuously, well
// inside that budget instead of burning it in under an hour.
const LIVE_TTL_MS = 10 * 60 * 1000;
interface LiveCacheEntry {
  rates: Record<string, number>;
  source: "twelvedata" | "frankfurter-fallback";
  asOf: string;
  expiresAt: number;
}
const liveCache = new Map<string, LiveCacheEntry>();

// Cache-stampede guard: several users/requests can land on the same
// (base, quotes) key at the same instant, all seeing a cache miss before
// the first one has finished populating it - without this, each would
// independently call Twelve Data and reserve its own credits, spiking
// usage in proportion to concurrent traffic instead of staying flat. Every
// caller for the same key while a fetch is already in flight awaits that
// one shared promise instead of starting its own.
const inFlight = new Map<string, Promise<LiveCacheEntry>>();

// After the daily-rate provider fails, don't call it again for a while: the
// forecast, cash position, dashboard and history all convert currencies on
// every request, and each attempt against an unreachable provider costs its
// full 8s timeout. Cached (even stale) rates keep serving meanwhile.
const PROVIDER_COOLDOWN_MS = 2 * 60 * 1000;
let providerDownUntil = 0;
const dailyInFlight = new Map<string, Promise<Awaited<ReturnType<FxProvider["getRates"]>>>>();

function todayDateOnly(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Common Service: cached FX reference rates. Checks today's cached rows
// first; only calls the live provider for whichever quotes are still
// missing for today, then persists them so the rest of the day (every
// other tenant/request) hits the cache, not the external API. If the
// provider is unreachable, falls back to the most recent cached rate for
// each missing quote (however old) rather than failing the whole request -
// a slightly-stale FX rate is far more useful to a treasury view than an
// error.
export const fxService = {
  async getRates(base: string, quotes: string[]): Promise<Record<string, number>> {
    const uniqueQuotes = Array.from(new Set(quotes.filter((q) => q !== base)));
    const result: Record<string, number> = { [base]: 1 };
    if (uniqueQuotes.length === 0) return result;

    const today = todayDateOnly();
    const cachedToday = await prisma.fxRate.findMany({
      where: { baseCurrency: base, quoteCurrency: { in: uniqueQuotes }, rateDate: today },
    });
    for (const row of cachedToday) result[row.quoteCurrency] = Number(row.rate);

    const missing = uniqueQuotes.filter((q) => !(q in result));
    if (missing.length === 0) return result;

    try {
      if (Date.now() < providerDownUntil) throw new Error("FX provider in cool-down after a recent failure");
      // Concurrent requests for the same pair share one call.
      const flightKey = `${base}:${[...missing].sort().join(",")}`;
      let flight = dailyInFlight.get(flightKey);
      if (!flight) {
        flight = provider.getRates(base, missing).finally(() => dailyInFlight.delete(flightKey));
        dailyInFlight.set(flightKey, flight);
      }
      const fresh = await flight;
      if (fresh.length > 0) {
        await prisma.fxRate.createMany({
          data: fresh.map((f) => ({ baseCurrency: f.base, quoteCurrency: f.quote, rate: f.rate, rateDate: new Date(f.date), provider: "frankfurter" })),
          skipDuplicates: true,
        });
        for (const f of fresh) result[f.quote] = f.rate;
      }
    } catch (err) {
      const alreadyCoolingDown = Date.now() < providerDownUntil;
      providerDownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
      // eslint-disable-next-line no-console
      if (!alreadyCoolingDown) console.error("[fx] live provider unreachable, falling back to last cached rate:", err);
    }

    const stillMissing = uniqueQuotes.filter((q) => !(q in result));
    if (stillMissing.length > 0) {
      const fallbackRows = await prisma.fxRate.findMany({
        where: { baseCurrency: base, quoteCurrency: { in: stillMissing } },
        orderBy: { rateDate: "desc" },
      });
      const seen = new Set<string>();
      for (const row of fallbackRows) {
        if (seen.has(row.quoteCurrency)) continue;
        seen.add(row.quoteCurrency);
        result[row.quoteCurrency] = Number(row.rate);
      }
    }

    return result;
  },

  async convert(amount: number, from: string, to: string): Promise<number> {
    if (from === to) return amount;
    const rates = await this.getRates(from, [to]);
    const rate = rates[to];
    if (rate === undefined) throw new Error(`No FX rate available for ${from} -> ${to}`);
    return amount * rate;
  },

  // Intraday/live rates (Twelve Data), separate from getRates() above
  // (Frankfurter, daily reference rates cached in fx_rates). Falls back to
  // that same daily rate - not an error - whenever TWELVEDATA_API_KEY
  // isn't set, the daily credit budget is exhausted, or the live call
  // itself fails, so a caller never has to handle "no live rate available"
  // as its own case; `source` tells the caller (and the UI) which one it
  // actually got. Every request - across every logged-in user, not just
  // one session - for the same (base, quotes) combination shares this one
  // cache entry and, via `inFlight` below, this one in-progress fetch, so
  // Twelve Data usage scales with the number of *distinct currency
  // combinations* being viewed, not the number of concurrent users viewing
  // them.
  async getLiveRates(base: string, quotes: string[]): Promise<{ base: string; rates: Record<string, number>; source: "twelvedata" | "frankfurter-fallback"; asOf: string }> {
    const uniqueQuotes = Array.from(new Set(quotes.filter((q) => q !== base)));
    const key = `${base}:${[...uniqueQuotes].sort().join(",")}`;

    const cached = liveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { base, rates: cached.rates, source: cached.source, asOf: cached.asOf };
    }

    const existing = inFlight.get(key);
    if (existing) {
      const entry = await existing;
      return { base, rates: entry.rates, source: entry.source, asOf: entry.asOf };
    }

    const fetchPromise = this.fetchLiveEntry(base, uniqueQuotes).finally(() => inFlight.delete(key));
    inFlight.set(key, fetchPromise);
    const entry = await fetchPromise;
    liveCache.set(key, entry);
    return { base, rates: entry.rates, source: entry.source, asOf: entry.asOf };
  },

  // Split out of getLiveRates purely so the in-flight de-duplication above
  // has a single promise-returning call to share - not meant to be called
  // directly (skips the cache/in-flight checks that make this safe). Any
  // failure here - unreachable API, or the daily budget already spent
  // (createTwelveDataProvider throws the same way for both, deliberately
  // indistinguishable, since this always reacts to either identically) -
  // falls back to the daily reference rate rather than erroring.
  async fetchLiveEntry(base: string, uniqueQuotes: string[]): Promise<LiveCacheEntry> {
    if (liveProvider && uniqueQuotes.length > 0) {
      try {
        const fresh = await liveProvider.getRates(base, uniqueQuotes);
        const rates: Record<string, number> = { [base]: 1 };
        for (const f of fresh) rates[f.quote] = f.rate;
        const asOf = new Date().toISOString();
        return { rates, source: "twelvedata", asOf, expiresAt: Date.now() + LIVE_TTL_MS };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[fx] Twelve Data unavailable (unreachable, or daily budget reached) - falling back to daily reference rate:", err);
      }
    }

    const rates = await this.getRates(base, uniqueQuotes);
    const asOf = new Date().toISOString();
    return { rates, source: "frankfurter-fallback", asOf, expiresAt: Date.now() + LIVE_TTL_MS };
  },

  // Transparency into the budget guardrail (enforced in fx-provider.ts) -
  // lets the UI show "X/250 used today" rather than the fallback being
  // invisible.
  getLiveRateUsage() {
    return { configured: !!liveProvider, ...getTwelveDataUsage() };
  },
};
