import { platformConfigService } from "../../common/platform-config.service";
import { requireRegistrationOpen } from "../../common/middleware/registration.middleware";
import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { created, ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { authenticate, authenticateSessionOrEnrollment } from "../../common/middleware/auth.middleware";
import { authLimiter } from "../../common/middleware/rate-limit.middleware";
import { authService } from "./auth.service";
import { mfaService } from "./mfa.service";
import { loginSchema, changePasswordSchema, registerSchema, mfaVerifySchema, mfaDisableSchema, mfaChallengeSchema } from "./auth.schemas";

export const authRouter = Router();

authRouter.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password, req.ip);
    ok(res, result);
  })
);

// Public: lets the login/registration pages know whether sign-up is open, so
// they can hide the "create an organisation" link and show a closed notice.
authRouter.get(
  "/registration-status",
  asyncHandler(async (_req, res) => ok(res, { open: await platformConfigService.isRegistrationEnabled() }))
);

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(requireRegistrationOpen),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body, req.ip);
    created(res, result);
  })
);

authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const me = await authService.me(req.user!.id);
    ok(res, me);
  })
);

authRouter.post(
  "/change-password",
  authLimiter,
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
    ok(res, result);
  })
);

// TOTP MFA - all opt-in, all require an authenticated session already (a
// user turns this on for their own account from Account settings; nobody
// else can start setup on their behalf). The one exception is /challenge,
// which necessarily runs *before* a session exists - it's authorized
// instead by the short-lived challengeToken from a password login.
authRouter.get(
  "/mfa/status",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await mfaService.status(req.user!.id);
    ok(res, result);
  })
);

authRouter.post(
  "/mfa/setup",
  authLimiter,
  authenticateSessionOrEnrollment,
  asyncHandler(async (req, res) => {
    const result = await mfaService.setup(req.user!.id);
    ok(res, result);
  })
);

authRouter.post(
  "/mfa/verify",
  authLimiter,
  authenticateSessionOrEnrollment,
  validate(mfaVerifySchema),
  asyncHandler(async (req, res) => {
    const result = await mfaService.verify(req.user!.id, req.body.code, { issueSession: req.mfaEnrollment });
    ok(res, result);
  })
);

authRouter.post(
  "/mfa/disable",
  authLimiter,
  authenticate,
  validate(mfaDisableSchema),
  asyncHandler(async (req, res) => {
    const result = await mfaService.disable(req.user!.id, req.body.password);
    ok(res, result);
  })
);

authRouter.post(
  "/mfa/challenge",
  authLimiter,
  validate(mfaChallengeSchema),
  asyncHandler(async (req, res) => {
    const result = await mfaService.challenge(req.body.challengeToken, req.body.code, req.ip);
    ok(res, result);
  })
);
