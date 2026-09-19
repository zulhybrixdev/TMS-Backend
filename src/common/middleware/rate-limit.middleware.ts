import rateLimit from "express-rate-limit";
import { env } from "../../config/env";

// Per-IP throttle for every endpoint that checks a secret (password, TOTP
// code, recovery code). In-memory per process, like the other in-process
// guards in this app (SLA sweep, Twelve Data budget) - fine for one
// process per tier as deployed today. Behind a reverse proxy, set
// `app.set("trust proxy", ...)` or every client shares the proxy's IP.
// Per-account lockout for MFA codes lives in mfa.service.ts, since an
// attacker rotating IPs would otherwise sidestep this.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.rateLimitAuthMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many attempts from this address. Please wait a few minutes and try again." },
    });
  },
});
