// Common Service: subscription plan catalog. Config-driven (not a DB table)
// so it stays a single source of truth, mirroring the PERMISSIONS/
// PERMISSION_CATALOG convention in ./permissions.ts. Plan changes here take
// effect immediately for every tenant since gating middleware reads the
// tenant's stored planKey fresh on every request rather than baking it into
// the JWT.

export const PLAN_KEYS = {
  FREE: "FREE",
  PRO: "PRO",
  PRO_PLUS: "PRO_PLUS",
} as const;

export type PlanKeyValue = (typeof PLAN_KEYS)[keyof typeof PLAN_KEYS];

// Optional modules a plan can unlock. Core modules (dashboard, bank
// accounts, cash position, payments, single-level approvals) are always
// available on every plan and are not listed here.
// Audit *logging* itself is unconditional for every tenant regardless of
// plan (compliance), and is always reviewable cross-tenant from the
// platform admin console (modules/platform/) - AUDIT below gates only
// self-serve *viewing* of a tenant's own log inside its own Administration
// (see audit-logs.routes.ts), which is genuinely Pro+-exclusive.
export const MODULE_KEYS = {
  INCOMING: "incoming",
  TRANSFERS: "transfers",
  APPROVAL_RULES: "approval_rules", // also covers SLA/escalation and cost-center/department routing - not separately gated
  FORECAST: "forecast",
  REPORTS_EXPORT: "reports_export",
  BENEFICIARIES: "beneficiaries", // saved payee book, bulk payment upload, payment templates
  AUDIT: "audit", // self-serve tenant audit trail viewing (Pro+ exclusive)
  ADVANCED_INSIGHTS: "advanced_insights", // executive dashboard, custom report builder, consolidated FX cash position, saved dashboard layout (Pro+ exclusive)
  TREASURY_DESK: "treasury_desk", // Daily Cash Desk, banker acceptances, cheque/bank-draft quotas, site cash reserve, daily-movement & BA reports (Pro+ exclusive)
  SSO: "sso", // Keycloak-brokered SSO (Pro+ exclusive) - see modules/auth/sso*.ts. Also hidden entirely for accountType=INDIVIDUAL tenants (frontend check, not plan-gated - a single-user tenant has no "company IdP" to federate)
} as const;

export type ModuleKeyValue = (typeof MODULE_KEYS)[keyof typeof MODULE_KEYS];

export interface PlanLimits {
  users: number | null; // null = unlimited
  bankAccounts: number | null;
}

export interface PlanDefinition {
  key: PlanKeyValue;
  name: string;
  priceMYR: number;
  billingCycle: "monthly" | null; // null for Free (never billed)
  description: string;
  modules: ModuleKeyValue[];
  limits: PlanLimits;
}

const PRO_MODULES: ModuleKeyValue[] = [
  MODULE_KEYS.INCOMING,
  MODULE_KEYS.TRANSFERS,
  MODULE_KEYS.APPROVAL_RULES,
  MODULE_KEYS.FORECAST,
  MODULE_KEYS.REPORTS_EXPORT,
  MODULE_KEYS.BENEFICIARIES,
];

// Everything in Pro, plus modules that are exclusively Pro+'s reason to
// exist beyond "higher user/account caps" - see common/plans.ts history:
// Pro and Pro+ used to share PRO_MODULES verbatim, so upgrading from Pro to
// Pro+ bought nothing but headroom.
const PRO_PLUS_MODULES: ModuleKeyValue[] = [...PRO_MODULES, MODULE_KEYS.AUDIT, MODULE_KEYS.ADVANCED_INSIGHTS, MODULE_KEYS.TREASURY_DESK, MODULE_KEYS.SSO];

export const PLAN_CATALOG: Record<PlanKeyValue, PlanDefinition> = {
  [PLAN_KEYS.FREE]: {
    key: PLAN_KEYS.FREE,
    name: "Free",
    priceMYR: 0,
    billingCycle: null,
    description: "Core treasury essentials to get started.",
    modules: [],
    limits: { users: 3, bankAccounts: 2 },
  },
  [PLAN_KEYS.PRO]: {
    key: PLAN_KEYS.PRO,
    name: "Pro",
    priceMYR: 99,
    billingCycle: "monthly",
    description: "The full treasury workflow, for a growing finance team.",
    modules: PRO_MODULES,
    limits: { users: 15, bankAccounts: 10 },
  },
  [PLAN_KEYS.PRO_PLUS]: {
    key: PLAN_KEYS.PRO_PLUS,
    name: "Pro+",
    priceMYR: 299,
    billingCycle: "monthly",
    description: "Everything in Pro, plus compliance, executive-level insight and single sign-on.",
    modules: PRO_PLUS_MODULES,
    limits: { users: null, bankAccounts: null },
  },
};

export function planIncludesModule(planKey: PlanKeyValue, moduleKey: ModuleKeyValue): boolean {
  return PLAN_CATALOG[planKey].modules.includes(moduleKey);
}
