import { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors";

// RBAC: require the authenticated user to hold at least one of the given
// permission codes. Permissions are resolved once at login time (see auth.service)
// and embedded in the JWT, so this check is a fast in-memory lookup.
export function requirePermission(...permissionCodes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());

    const hasPermission = permissionCodes.some((code) =>
      req.user!.permissions.includes(code)
    );
    if (!hasPermission) {
      return next(
        new ForbiddenError(
          `Missing required permission: ${permissionCodes.join(" or ")}`
        )
      );
    }
    next();
  };
}

export function requireRole(...roleNames: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    const hasRole = roleNames.some((r) => req.user!.roles.includes(r));
    if (!hasRole) {
      return next(new ForbiddenError(`Requires role: ${roleNames.join(" or ")}`));
    }
    next();
  };
}
