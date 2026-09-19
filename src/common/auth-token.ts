import jwt from "jsonwebtoken";
import { prisma } from "./prisma";
import { env } from "../config/env";
import { AuthUser } from "../types/express";

// Shared by auth.service.ts (normal tenant login/register) and
// platform.service.ts (platform-admin impersonation) so both mint
// identical tenant JWTs - impersonation is just a tenant token with one
// extra claim, not a separate auth system.

export async function loadAuthUser(userId: string): Promise<AuthUser & { jobTitle: string | null; email: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
  });

  const roles = user.roles.map((ur) => ur.role.name);
  const permissions = Array.from(
    new Set(user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.code)))
  );

  return { id: user.id, tenantId: user.tenantId, email: user.email, name: user.name, jobTitle: user.jobTitle, roles, permissions };
}

export function signTenantToken(authUser: AuthUser, opts?: { impersonatedByPlatformAdminId?: string }): string {
  return jwt.sign(
    {
      id: authUser.id,
      tenantId: authUser.tenantId,
      email: authUser.email,
      name: authUser.name,
      roles: authUser.roles,
      permissions: authUser.permissions,
      ...(opts?.impersonatedByPlatformAdminId ? { impersonatedByPlatformAdminId: opts.impersonatedByPlatformAdminId } : {}),
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn } as jwt.SignOptions
  );
}

// A password was correct but the account has TOTP MFA enabled - this
// narrow, 5-minute token is handed back instead of a real session token
// (see auth.service.ts's login()), carrying only enough to complete the
// challenge. It deliberately has no roles/permissions and a `purpose`
// claim, which `authenticate` middleware (auth.middleware.ts) rejects
// outright - so even if this token leaked or was replayed against a
// normal API route, it can't be used as a session, only against
// POST /auth/mfa/challenge.
const MFA_CHALLENGE_PURPOSE = "mfa_challenge";

export function signMfaChallengeToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: MFA_CHALLENGE_PURPOSE }, env.jwtSecret, { expiresIn: "5m" });
}

// Issued instead of a session when the tenant requires MFA and this user
// hasn't set it up yet. Accepted ONLY by POST /auth/mfa/setup and /verify
// (authenticateSessionOrEnrollment) - like the challenge token, plain
// `authenticate` rejects it via the `purpose` claim, so it can't be used to
// reach anything else. Completing /verify swaps it for a real session.
const MFA_ENROLL_PURPOSE = "mfa_enroll";

export function signMfaEnrollmentToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: MFA_ENROLL_PURPOSE }, env.jwtSecret, { expiresIn: "15m" });
}

export function verifyMfaEnrollmentToken(token: string): string {
  const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
  if (payload.purpose !== MFA_ENROLL_PURPOSE || typeof payload.sub !== "string") {
    throw new Error("Not a valid MFA enrollment token");
  }
  return payload.sub;
}

export function verifyMfaChallengeToken(token: string): string {
  const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
  if (payload.purpose !== MFA_CHALLENGE_PURPOSE || typeof payload.sub !== "string") {
    throw new Error("Not a valid MFA challenge token");
  }
  return payload.sub;
}
