import { NextFunction, Request, Response } from "express";
import { UnauthorizedError, PlanUpgradeRequiredError } from "../errors";
import { ModuleKeyValue, PLAN_CATALOG, PlanKeyValue } from "../plans";

// Plan gating: require the tenant's current subscription plan to include at
// least one of the given module keys. Requires tenantContext to have run
// first (populates req.subscription). Mirrors requirePermission()'s shape
// but reports a distinct error code so the frontend can show an upsell
// prompt instead of a generic "forbidden" toast.
export function requireModule(...moduleKeys: ModuleKeyValue[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.subscription) return next(new UnauthorizedError());

    // Platform-admin impersonation sees every module regardless of the
    // tenant's actual plan - "overseer everything" for support purposes.
    if (req.user?.impersonatedByPlatformAdminId) return next();

    const planKey = req.subscription.planKey as PlanKeyValue;
    const planModules = PLAN_CATALOG[planKey]?.modules ?? [];
    const hasModule = moduleKeys.some((key) => planModules.includes(key));

    if (!hasModule) {
      return next(
        new PlanUpgradeRequiredError(
          `This feature requires an upgrade (needs: ${moduleKeys.join(" or ")})`,
          { requiredModules: moduleKeys, currentPlan: planKey }
        )
      );
    }
    next();
  };
}
