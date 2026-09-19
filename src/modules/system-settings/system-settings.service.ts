import { prisma } from "../../common/prisma";
import { auditService } from "../../common/audit.service";

// Common Service: typed key/value system configuration, scoped per tenant.
// Backs the Administration > System Settings screen and lets other modules
// (cash engine invocation, approvals) read tunables without hard-coding them.

export const SETTING_KEYS = {
  MAX_SWEEP_RATIO: "cash_engine.max_sweep_ratio",
  RESTRICT_TRANSFERS_TO_SAME_CURRENCY: "cash_engine.restrict_to_same_currency",
  ALLOW_SELF_APPROVAL: "approvals.allow_self_approval",
  APPROVAL_DEFAULT_SLA_HOURS: "approvals.default_sla_hours",
  BASE_CURRENCY: "system.base_currency",
  COMPANY_NAME: "system.company_name",
} as const;

export const DEFAULT_SETTINGS: Record<string, { value: string; description: string }> = {
  [SETTING_KEYS.MAX_SWEEP_RATIO]: {
    value: "1",
    description: "Max fraction (0-1) of an account's excess cash that may be swept in one recommendation",
  },
  [SETTING_KEYS.RESTRICT_TRANSFERS_TO_SAME_CURRENCY]: {
    value: "true",
    description: "Only recommend transfers between accounts of the same currency",
  },
  [SETTING_KEYS.ALLOW_SELF_APPROVAL]: {
    value: "false",
    description: "Allow a user to approve their own payment/transfer request",
  },
  [SETTING_KEYS.APPROVAL_DEFAULT_SLA_HOURS]: {
    value: "48",
    description: "Hours before a pending approval (with no rule-specific SLA) is flagged overdue and re-notified",
  },
  [SETTING_KEYS.BASE_CURRENCY]: { value: "MYR", description: "Reporting/base currency" },
  [SETTING_KEYS.COMPANY_NAME]: { value: "Your Company", description: "Company name shown in reports" },
};

export const systemSettingsService = {
  async list(tenantId: string) {
    const rows = await prisma.systemSetting.findMany({ where: { tenantId }, orderBy: { key: "asc" } });
    return rows;
  },

  async get(tenantId: string, key: string): Promise<string | undefined> {
    const row = await prisma.systemSetting.findUnique({ where: { tenantId_key: { tenantId, key } } });
    return row?.value ?? DEFAULT_SETTINGS[key]?.value;
  },

  async getBool(tenantId: string, key: string): Promise<boolean> {
    const v = await this.get(tenantId, key);
    return v === "true";
  },

  async getNumber(tenantId: string, key: string): Promise<number> {
    const v = await this.get(tenantId, key);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  },

  async set(tenantId: string, key: string, value: string, updatedById: string, description?: string) {
    const before = await prisma.systemSetting.findUnique({ where: { tenantId_key: { tenantId, key } } });
    const row = await prisma.systemSetting.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, value, description, updatedById },
      update: { value, updatedById, ...(description ? { description } : {}) },
    });
    await auditService.record({
      tenantId,
      actorId: updatedById,
      action: "system_setting.update",
      entityType: "SystemSetting",
      entityId: key,
      beforeState: before,
      afterState: row,
    });
    return row;
  },
};
