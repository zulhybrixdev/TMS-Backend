import crypto from "crypto";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { UnauthorizedError, BadRequestError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { loadAuthUser, signTenantToken, verifyMfaChallengeToken } from "../../common/auth-token";
import { encryptTotpSecret, decryptTotpSecret } from "../../common/mfa-crypto";

const ISSUER = "Treasury System";

// Per-account brute-force lockout for the MFA challenge: a 6-digit code has
// only 10^6 values, so IP throttling alone (see rate-limit.middleware.ts)
// isn't enough against an attacker who rotates IPs. In-memory per process,
// same trade-off as the rest of the app's in-process guards.
const MAX_MFA_FAILURES = 5;
const MFA_LOCKOUT_MS = 15 * 60 * 1000;
const mfaFailures = new Map<string, { count: number; lockedUntil: number }>();

function assertNotLockedOut(userId: string) {
  const entry = mfaFailures.get(userId);
  if (entry && entry.lockedUntil > Date.now()) {
    throw new UnauthorizedError("Too many incorrect codes - this account is locked for a few minutes. Try again later.");
  }
}

function recordMfaFailure(userId: string) {
  // lockedUntil === 0 means "still counting"; a non-zero (expired, since
  // assertNotLockedOut already threw for active ones) entry starts over.
  const entry = mfaFailures.get(userId);
  const count = (entry && entry.lockedUntil === 0 ? entry.count : 0) + 1;
  mfaFailures.set(userId, { count, lockedUntil: count >= MAX_MFA_FAILURES ? Date.now() + MFA_LOCKOUT_MS : 0 });
}

const RECOVERY_CODE_COUNT = 8;

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// Everything here is opt-in - a user reaches this only by visiting their
// own Account settings and choosing to turn MFA on; nothing calls these
// automatically. See User.totpEnabled defaulting to false.
export const mfaService = {
  // Deliberately not folded into loadAuthUser()/the JWT - that would grow
  // every route's req.user and the token payload for a value only the
  // Account settings page needs to show ("MFA: on/off").
  async status(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabled: true } });
    const recoveryCodesRemaining = user.totpEnabled ? await prisma.userRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
    return { enabled: user.totpEnabled, recoveryCodesRemaining };
  },

  // Step 1: generate (but don't yet activate) a TOTP secret. totpEnabled
  // stays false until verify() confirms the user actually has it working
  // in an authenticator app - avoids ever locking someone out on a typo'd
  // scan.
  async setup(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabled) throw new BadRequestError("MFA is already enabled - disable it first to re-configure");

    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: userId }, data: { totpSecret: encryptTotpSecret(secret) } });

    return { secret, otpauthUrl: authenticator.keyuri(user.email, ISSUER, secret) };
  },

  // Step 2: confirm the user's authenticator app is actually producing
  // valid codes before flipping totpEnabled - this is the point of no
  // return where recovery codes are minted and shown exactly once.
  async verify(userId: string, code: string, opts: { issueSession?: boolean } = {}) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret) throw new BadRequestError("Call /auth/mfa/setup first");

    const secret = decryptTotpSecret(user.totpSecret);
    if (!authenticator.check(code, secret)) throw new BadRequestError("Invalid code");

    const recoveryCodes = generateRecoveryCodes();
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } }),
      prisma.userRecoveryCode.deleteMany({ where: { userId } }),
      prisma.userRecoveryCode.createMany({
        data: await Promise.all(recoveryCodes.map(async (code) => ({ userId, codeHash: await bcrypt.hash(code, env.bcryptSaltRounds) }))),
      }),
    ]);

    await auditService.record({ tenantId: user.tenantId, actorId: userId, action: "auth.mfa_enabled", entityType: "User", entityId: userId });

    // Enrollment-token flow (tenant requires MFA): confirming the code is
    // what completes the login the password step started, so hand back the
    // real session here rather than making the user log in again.
    if (opts.issueSession) {
      const authUser = await loadAuthUser(userId);
      await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
      await auditService.record({ tenantId: user.tenantId, actorId: userId, action: "auth.login", entityType: "User", entityId: userId });
      return { enabled: true, recoveryCodes, token: signTenantToken(authUser), user: authUser };
    }
    return { enabled: true, recoveryCodes };
  },

  // Re-checks the password (not just an active session) before turning
  // off a security feature - the same reasoning as changePassword()
  // requiring the current password, just applied to disabling MFA too.
  async disable(userId: string, password: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) throw new BadRequestError("Current password is incorrect");

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { mfaRequired: true } });
    if (tenant.mfaRequired) throw new BadRequestError("Your organisation requires two-factor authentication, so it can't be turned off");

    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null } }),
      prisma.userRecoveryCode.deleteMany({ where: { userId } }),
    ]);

    await auditService.record({ tenantId: user.tenantId, actorId: userId, action: "auth.mfa_disabled", entityType: "User", entityId: userId });
    return { disabled: true };
  },

  // Step 2 of login for an MFA-enabled account (see auth.service.ts's
  // login()) - exchanges the narrow challengeToken plus a 6-digit TOTP
  // code (or an unused recovery code) for a real session token, via the
  // same signTenantToken() every other login path uses.
  async challenge(challengeToken: string, code: string, ipAddress?: string) {
    let userId: string;
    try {
      userId = verifyMfaChallengeToken(challengeToken);
    } catch {
      throw new UnauthorizedError("MFA challenge expired - please sign in again");
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpEnabled || !user.totpSecret) throw new UnauthorizedError("MFA challenge expired - please sign in again");
    assertNotLockedOut(userId);

    const normalizedCode = code.trim();
    let usedRecoveryCode = false;

    if (authenticator.check(normalizedCode, decryptTotpSecret(user.totpSecret))) {
      // valid TOTP code
    } else {
      const unusedCodes = await prisma.userRecoveryCode.findMany({ where: { userId, usedAt: null } });
      const match = await Promise.all(unusedCodes.map(async (rc) => ((await bcrypt.compare(normalizedCode, rc.codeHash)) ? rc : null))).then((rows) => rows.find(Boolean));
      if (!match) {
        recordMfaFailure(userId);
        throw new UnauthorizedError("Invalid code");
      }
      await prisma.userRecoveryCode.update({ where: { id: match.id }, data: { usedAt: new Date() } });
      usedRecoveryCode = true;
    }

    mfaFailures.delete(userId);
    const authUser = await loadAuthUser(userId);
    const token = signTenantToken(authUser);
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await auditService.record({
      tenantId: authUser.tenantId,
      actorId: userId,
      action: usedRecoveryCode ? "auth.mfa_recovery_code_used" : "auth.mfa_challenge_success",
      entityType: "User",
      entityId: userId,
      ipAddress,
    });

    return { token, user: authUser };
  },
};
