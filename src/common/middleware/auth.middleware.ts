import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { UnauthorizedError } from "../errors";
import { prisma } from "../prisma";
import { verifyMfaEnrollmentToken } from "../auth-token";
import { AuthUser } from "../../types/express";

// Verifies the JWT bearer token and attaches the authenticated user
// (with resolved roles/permissions, baked into the token at login) to req.user.
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthUser & { iat: number; exp: number; purpose?: string };
    // Narrow-purpose tokens (e.g. the MFA challenge token from
    // auth-token.ts) are signed with the same secret but must never be
    // usable as a real session - reject anything carrying a `purpose`
    // claim here rather than trusting it just because it verifies.
    if (payload.purpose) {
      return next(new UnauthorizedError("Invalid or expired token"));
    }
    req.user = {
      id: payload.id,
      tenantId: payload.tenantId,
      email: payload.email,
      name: payload.name,
      roles: payload.roles,
      permissions: payload.permissions,
      impersonatedByPlatformAdminId: payload.impersonatedByPlatformAdminId,
    };
    next();
  } catch {
    next(new UnauthorizedError("Invalid or expired token"));
  }
}

// For POST /auth/mfa/setup and /verify only: accepts a normal session OR the
// short-lived enrollment token issued when the tenant requires MFA and this
// user hasn't enrolled yet. An enrollment token yields a bare req.user (id +
// tenant, no roles/permissions) and req.mfaEnrollment = true.
export async function authenticateSessionOrEnrollment(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const userId = verifyMfaEnrollmentToken(header.slice("Bearer ".length));
      const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null, status: "ACTIVE" } });
      if (!user) return next(new UnauthorizedError("Invalid or expired token"));
      req.user = { id: user.id, tenantId: user.tenantId, email: user.email, name: user.name, roles: [], permissions: [] };
      req.mfaEnrollment = true;
      return next();
    } catch {
      // not an enrollment token - fall through to normal session auth
    }
  }
  return authenticate(req, res, next);
}
