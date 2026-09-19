import { Request, Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/async-handler";
import { AppError, BadRequestError } from "../../common/errors";
import { env } from "../../config/env";
import { authLimiter } from "../../common/middleware/rate-limit.middleware";
import { ssoService, SSO_STATE_COOKIE, SSO_STATE_MAX_AGE_MS } from "./sso.service";

export const ssoRouter = Router();
ssoRouter.use(authLimiter);

const cookieOptions = {
  httpOnly: true,
  // Lax still sends the cookie on the top-level GET redirect back from
  // Keycloak, but not on cross-site subrequests/forms.
  sameSite: "lax" as const,
  secure: env.keycloakRedirectUri.startsWith("https://"),
  path: "/api/auth/sso",
};

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function failToLogin(res: Response, err: unknown) {
  const message = err instanceof AppError ? err.message : "SSO sign-in failed";
  res.clearCookie(SSO_STATE_COOKIE, cookieOptions);
  res.redirect(`${env.appUrl}/login?ssoError=${encodeURIComponent(message)}`);
}

// Public - this is the login entry point itself, necessarily reachable
// before any session exists (see LoginPage's "Sign in with company SSO").
// Only reaches Keycloak at all if the tenant has a TenantSsoConfig row on a
// plan that still includes SSO - see sso.service.ts.
ssoRouter.get(
  "/:tenantSlug/start",
  asyncHandler(async (req, res) => {
    try {
      const { url, cookieValue } = await ssoService.startAuthorization(req.params.tenantSlug);
      res.cookie(SSO_STATE_COOKIE, cookieValue, { ...cookieOptions, maxAge: SSO_STATE_MAX_AGE_MS });
      res.redirect(url);
    } catch (err) {
      failToLogin(res, err);
    }
  })
);

const callbackQuerySchema = z.object({ code: z.string(), state: z.string() });

ssoRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const parsed = callbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return failToLogin(res, new BadRequestError("Invalid SSO callback"));

    try {
      const result = await ssoService.handleCallback({
        code: parsed.data.code,
        state: parsed.data.state,
        cookieValue: readCookie(req, SSO_STATE_COOKIE),
        ipAddress: req.ip,
      });
      res.clearCookie(SSO_STATE_COOKIE, cookieOptions); // single use
      // Fragment, not query string, so the token never appears in this
      // redirect's own request line beyond this one hop, and the browser's
      // *next* navigation (to /sso-callback) never sends it back to any
      // server at all - SsoCallbackPage.tsx reads it client-side only.
      res.redirect(`${env.appUrl}/sso-callback#token=${encodeURIComponent(result.token)}`);
    } catch (err) {
      failToLogin(res, err);
    }
  })
);
