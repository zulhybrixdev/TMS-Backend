import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../errors";
import { announcementsService } from "../../modules/announcements/announcements.service";

// While a maintenance / downtime announcement with "lock the system" is in
// progress, every tenant API request is refused with 503 MAINTENANCE_MODE -
// sign-in included - so nobody can use the system by any route (a stale open
// tab, a script), not just the ones that respect the full-screen notice.
// It lifts by itself when the window ends, or the moment the announcement is
// ended or deleted in Platform Console.
//
// Still allowed, so the system can be observed, managed and put back:
//   /announcements/active   the notice itself (and how the app learns it was lifted)
//   /auth/registration-status, /meta, /docs
//   /platform/*             Platform Console - staff must be able to lift the lock
//   /billing/*              payment-gateway callbacks (signature-verified) - a
//                           payment confirmation must not be lost to maintenance
//   requests carrying a platform-support impersonation token (staff verifying the system)
const ALLOWED_PREFIXES = ["/announcements", "/auth/registration-status", "/meta", "/docs", "/platform", "/billing"];

function isImpersonation(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { impersonatedByPlatformAdminId?: string };
    return !!payload.impersonatedByPlatformAdminId;
  } catch {
    return false;
  }
}

export async function maintenanceGuard(req: Request, _res: Response, next: NextFunction) {
  if (ALLOWED_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))) return next();
  let lock;
  try {
    lock = await announcementsService.getActiveLock();
  } catch {
    return next(); // if the announcement lookup itself fails, don't take the whole system down with it
  }
  if (!lock || isImpersonation(req)) return next();
  next(new AppError(503, "MAINTENANCE_MODE", "The system is temporarily unavailable for maintenance. Please try again shortly.", { lockedUntil: lock.lockedUntil }));
}
