import { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma";
import { TenantSuspendedError, UnauthorizedError } from "../errors";
import { PLAN_KEYS } from "../plans";

// Loads the authenticated user's tenant + subscription fresh on every
// request (a cheap PK lookup) and attaches it as req.subscription. Kept
// separate from the JWT (unlike roles/permissions) so a plan upgrade or
// downgrade - or a platform admin suspending the tenant - takes effect
// immediately, without the user needing to log in again.
export async function tenantContext(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new UnauthorizedError());

  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    include: { subscription: true },
  });

  if (!tenant) return next(new TenantSuspendedError("Tenant not found"));

  // A platform admin viewing this tenant via impersonation must still be
  // able to see it even while suspended (that's often exactly when support
  // needs to look) - every other session is blocked.
  if (tenant.status === "SUSPENDED" && !req.user.impersonatedByPlatformAdminId) {
    return next(new TenantSuspendedError());
  }

  req.subscription = {
    tenantId: req.user.tenantId,
    planKey: tenant.subscription?.planKey ?? PLAN_KEYS.FREE,
    status: tenant.subscription?.status ?? "ACTIVE",
  };
  next();
}
