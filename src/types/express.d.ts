import "express";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  // Set only on a token minted by platform.service#impersonateTenant - a
  // platform admin viewing this tenant as its Admin user for support
  // oversight. Bypasses plan-module gating and the suspended-tenant block
  // (see plan.middleware.ts / tenant.middleware.ts) so nothing is hidden
  // from platform support regardless of the tenant's actual plan/status.
  impersonatedByPlatformAdminId?: string;
}

// Resolved fresh per-request (not baked into the JWT) so an upgrade/
// downgrade takes effect immediately without requiring re-login.
export interface TenantSubscriptionContext {
  tenantId: string;
  planKey: string;
  status: string;
}

// A platform-level operator (see modules/platform/) - entirely separate
// from tenant-scoped AuthUser, never carries a tenantId.
export interface PlatformAdminAuth {
  id: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      subscription?: TenantSubscriptionContext;
      platformAdmin?: PlatformAdminAuth;
      // True when req.user came from an MFA enrollment token rather than a
      // real session (see authenticateSessionOrEnrollment).
      mfaEnrollment?: boolean;
    }
  }
}
