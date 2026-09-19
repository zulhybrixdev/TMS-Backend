import { Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { BadRequestError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

export interface SsoConfigInput {
  keycloakIdpAlias: string;
  ssoRequired: boolean;
  autoProvisionUsers: boolean;
  // e.g. ["acme.com"]; empty/omitted = no restriction
  allowedEmailDomains?: string[];
}

// Administration -> Security tab's backend. Gated at the route level by
// requireModule(MODULE_KEYS.SSO) (Pro+) and requirePermission(SETTINGS_MANAGE)
// - both apply to every method here since managing SSO is itself an
// admin-only action, not just using it.
export const ssoConfigService = {
  async get(tenantId: string) {
    return prisma.tenantSsoConfig.findUnique({ where: { tenantId } });
  },

  // Single row per tenant (upsert, not create) - a tenant either has SSO
  // configured or doesn't; re-saving the Security tab's form just updates
  // the existing row. accountType=INDIVIDUAL is rejected here rather than
  // only hidden in the UI, since the UI check alone wouldn't stop a direct
  // API call - there's genuinely no "company IdP" concept for a
  // single-user tenant (mirrors the 1-user cap already enforced in
  // users.service.ts for the same account type).
  async upsert(tenantId: string, input: SsoConfigInput, actorId: string | null, platformAdminId?: string) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (tenant.accountType === "INDIVIDUAL") {
      throw new BadRequestError("SSO isn't available for individual accounts - there's no separate company identity provider to federate with");
    }
    if (!input.keycloakIdpAlias.trim()) throw new BadRequestError("Identity Provider alias is required");

    const domains = (input.allowedEmailDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    const data = {
      keycloakIdpAlias: input.keycloakIdpAlias.trim(),
      ssoRequired: input.ssoRequired,
      autoProvisionUsers: input.autoProvisionUsers,
      allowedEmailDomains: domains.length > 0 ? domains : Prisma.JsonNull,
    };
    const config = await prisma.tenantSsoConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    await auditService.record({
      tenantId,
      actorId,
      action: platformAdminId ? "platform.sso_config_save" : "sso_config.save",
      entityType: "TenantSsoConfig",
      entityId: config.id,
      afterState: platformAdminId ? { ...config, platformAdminId } : config,
    });
    return config;
  },

  async remove(tenantId: string, actorId: string | null, platformAdminId?: string) {
    const config = await prisma.tenantSsoConfig.findUnique({ where: { tenantId } });
    if (!config) throw new NotFoundError("SSO is not configured");
    await prisma.tenantSsoConfig.delete({ where: { tenantId } });
    await auditService.record({
      tenantId,
      actorId,
      action: platformAdminId ? "platform.sso_config_remove" : "sso_config.remove",
      entityType: "TenantSsoConfig",
      entityId: config.id,
      beforeState: config,
      ...(platformAdminId ? { afterState: { platformAdminId } } : {}),
    });
    return { deleted: true };
  },
};
