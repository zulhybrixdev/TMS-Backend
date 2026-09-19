import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { BadRequestError } from "../../common/errors";
import { requireModule } from "../../common/middleware/plan.middleware";
import { MODULE_KEYS } from "../../common/plans";
import { fxService } from "./fx.service";

export const fxRouter = Router();
fxRouter.use(requireModule(MODULE_KEYS.ADVANCED_INSIGHTS));

fxRouter.get(
  "/rates",
  asyncHandler(async (req, res) => {
    const base = String(req.query.base ?? "").toUpperCase();
    const quotes = String(req.query.quotes ?? "")
      .split(",")
      .map((q) => q.trim().toUpperCase())
      .filter(Boolean);
    if (base.length !== 3) throw new BadRequestError("base must be a 3-letter currency code");
    if (quotes.length === 0) throw new BadRequestError("quotes must be a comma-separated list of 3-letter currency codes");

    const rates = await fxService.getRates(base, quotes);
    ok(res, { base, rates });
  })
);

// Intraday/live rates (Twelve Data if configured, else the same daily
// Frankfurter rate as /rates above - see fx.service.ts's getLiveRates).
fxRouter.get(
  "/live-rates",
  asyncHandler(async (req, res) => {
    const base = String(req.query.base ?? "").toUpperCase();
    const quotes = String(req.query.quotes ?? "")
      .split(",")
      .map((q) => q.trim().toUpperCase())
      .filter(Boolean);
    if (base.length !== 3) throw new BadRequestError("base must be a 3-letter currency code");
    if (quotes.length === 0) throw new BadRequestError("quotes must be a comma-separated list of 3-letter currency codes");

    ok(res, await fxService.getLiveRates(base, quotes));
  })
);

// Transparency into the Twelve Data daily budget guard (see fx.service.ts)
// - this process's own usage only, not the shared account-wide total.
fxRouter.get("/live-rates/usage", asyncHandler(async (_req, res) => ok(res, fxService.getLiveRateUsage())));
