// Common Service: canonical permission catalog. Seeded into the `permissions`
// table (see prisma/seed.ts) and used by RBAC middleware / the Administration
// screen. Keeping the catalog in one typed file avoids typos between the
// seed script and route guards.

export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",

  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",

  BANKS_MANAGE: "banks.manage",
  ACCOUNTS_VIEW: "accounts.view",
  ACCOUNTS_MANAGE: "accounts.manage",

  CASH_POSITION_VIEW: "cash_position.view",

  PAYMENTS_VIEW: "payments.view",
  PAYMENTS_CREATE: "payments.create",

  BENEFICIARIES_VIEW: "beneficiaries.view",
  BENEFICIARIES_MANAGE: "beneficiaries.manage",

  INCOMING_VIEW: "incoming.view",
  INCOMING_MANAGE: "incoming.manage",

  TRANSFERS_VIEW: "transfers.view",
  TRANSFERS_CREATE: "transfers.create",

  APPROVALS_ACT: "approvals.act",
  APPROVAL_RULES_MANAGE: "approval_rules.manage",

  FORECASTS_VIEW: "forecasts.view",
  FORECASTS_MANAGE: "forecasts.manage",

  REPORTS_VIEW: "reports.view",
  REPORTS_EXPORT: "reports.export",

  AUDIT_VIEW: "audit.view",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATALOG: { code: PermissionCode; module: string; description: string }[] = [
  { code: PERMISSIONS.DASHBOARD_VIEW, module: "Dashboard", description: "View treasury dashboard" },

  { code: PERMISSIONS.USERS_MANAGE, module: "Administration", description: "Manage users" },
  { code: PERMISSIONS.ROLES_MANAGE, module: "Administration", description: "Manage roles & permissions" },

  { code: PERMISSIONS.BANKS_MANAGE, module: "Bank Accounts", description: "Manage banks" },
  { code: PERMISSIONS.ACCOUNTS_VIEW, module: "Bank Accounts", description: "View bank accounts" },
  { code: PERMISSIONS.ACCOUNTS_MANAGE, module: "Bank Accounts", description: "Create/edit bank accounts, balances, min/target" },

  { code: PERMISSIONS.CASH_POSITION_VIEW, module: "Cash Position", description: "View consolidated cash position" },

  { code: PERMISSIONS.PAYMENTS_VIEW, module: "Payments", description: "View payments" },
  { code: PERMISSIONS.PAYMENTS_CREATE, module: "Payments", description: "Create & submit payments" },

  { code: PERMISSIONS.BENEFICIARIES_VIEW, module: "Payments", description: "View saved beneficiaries & payment templates" },
  { code: PERMISSIONS.BENEFICIARIES_MANAGE, module: "Payments", description: "Manage saved beneficiaries & payment templates, use bulk payment upload" },

  { code: PERMISSIONS.INCOMING_VIEW, module: "Incoming", description: "View incoming transactions" },
  { code: PERMISSIONS.INCOMING_MANAGE, module: "Incoming", description: "Record/reconcile incoming transactions" },

  { code: PERMISSIONS.TRANSFERS_VIEW, module: "Transfers", description: "View inter-bank transfers" },
  { code: PERMISSIONS.TRANSFERS_CREATE, module: "Transfers", description: "Create & submit transfers" },

  { code: PERMISSIONS.APPROVALS_ACT, module: "Approvals", description: "Approve/reject payments & transfers" },
  { code: PERMISSIONS.APPROVAL_RULES_MANAGE, module: "Approvals", description: "Configure approval rules" },

  { code: PERMISSIONS.FORECASTS_VIEW, module: "Forecast", description: "View cash forecast" },
  { code: PERMISSIONS.FORECASTS_MANAGE, module: "Forecast", description: "Add manual forecast entries" },

  { code: PERMISSIONS.REPORTS_VIEW, module: "Reports", description: "View reports" },
  { code: PERMISSIONS.REPORTS_EXPORT, module: "Reports", description: "Export reports (CSV)" },

  { code: PERMISSIONS.AUDIT_VIEW, module: "Audit", description: "View audit trail" },
  { code: PERMISSIONS.SETTINGS_MANAGE, module: "Administration", description: "Manage system settings" },
];

// Default role → permission mapping used by the seed script.
export const ROLE_NAMES = {
  ADMIN: "Admin",
  FINANCE_MAKER: "Finance Maker",
  FINANCE_CHECKER: "Finance Checker",
  FINANCE_MANAGER: "Finance Manager",
  VIEWER: "Viewer",
} as const;

const VIEW_ONLY: PermissionCode[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.ACCOUNTS_VIEW,
  PERMISSIONS.CASH_POSITION_VIEW,
  PERMISSIONS.PAYMENTS_VIEW,
  PERMISSIONS.BENEFICIARIES_VIEW,
  PERMISSIONS.INCOMING_VIEW,
  PERMISSIONS.TRANSFERS_VIEW,
  PERMISSIONS.FORECASTS_VIEW,
  PERMISSIONS.REPORTS_VIEW,
];

export const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionCode[]> = {
  [ROLE_NAMES.ADMIN]: PERMISSION_CATALOG.map((p) => p.code),
  [ROLE_NAMES.FINANCE_MAKER]: [
    ...VIEW_ONLY,
    PERMISSIONS.PAYMENTS_CREATE,
    PERMISSIONS.BENEFICIARIES_MANAGE,
    PERMISSIONS.TRANSFERS_CREATE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.FORECASTS_MANAGE,
  ],
  [ROLE_NAMES.FINANCE_CHECKER]: [...VIEW_ONLY, PERMISSIONS.APPROVALS_ACT],
  [ROLE_NAMES.FINANCE_MANAGER]: [
    ...VIEW_ONLY,
    PERMISSIONS.APPROVALS_ACT,
    PERMISSIONS.APPROVAL_RULES_MANAGE,
    PERMISSIONS.ACCOUNTS_MANAGE,
    PERMISSIONS.BANKS_MANAGE,
    PERMISSIONS.BENEFICIARIES_MANAGE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.FORECASTS_MANAGE,
    PERMISSIONS.REPORTS_EXPORT,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.SETTINGS_MANAGE,
  ],
  [ROLE_NAMES.VIEWER]: VIEW_ONLY,
};
