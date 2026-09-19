import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { UnauthorizedError } from "../errors";
import { PlatformAdminAuth } from "../../types/express";

// Verifies a platform-admin JWT (distinguished from a tenant AuthUser JWT
// by its `scope: "platform"` claim, so one can never be used in place of
// the other even though both are signed with the same secret).
export function authenticatePlatform(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing or invalid Authorization header"));
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, env.jwtSecret) as PlatformAdminAuth & { scope?: string; iat: number; exp: number };
    if (payload.scope !== "platform") {
      return next(new UnauthorizedError("Invalid token for this endpoint"));
    }
    req.platformAdmin = { id: payload.id, email: payload.email, name: payload.name };
    next();
  } catch {
    next(new UnauthorizedError("Invalid or expired token"));
  }
}
