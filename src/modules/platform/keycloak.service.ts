import { z } from "zod";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { MODULE_KEYS, PLAN_CATALOG, PlanKeyValue, planIncludesModule } from "../../common/plans";
import { ssoConfigService } from "../auth/sso-config.service";
import { keycloakAdmin, CreateIdpInput } from "../../common/keycloak-admin";

// Platform Console -> Identity / SSO. Platform staff register a customer's
// identity provider here (Keycloak does the protocol work); the customer's
// own admin then types that alias into their Administration -> Security tab.
// Platform-level actions aren't tenant-scoped, so they're recorded as
// structured log lines rather than in the per-tenant audit table.
const log = (action: string, adminId: string, detail: Record<string, unknown>) =>
  // eslint-disable-next-line no-console
  console.info("[platform-audit]", JSON.stringify({ at: new Date().toISOString(), action, platformAdminId: adminId, ...detail }));

export const createIdpSchema = z
  .object({
    alias: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use lowercase letters, numbers and hyphens (2-63 characters), e.g. acme-corp-saml"),
    displayName: z.string().max(100).optional(),
    protocol: z.enum(["oidc", "saml"]),
    importUrl: z.string().url("Enter the full https:// URL"),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    trustEmail: z.boolean().default(true),
    // When registering from a tenant's own SSO dialog: also record it in that tenant's audit timeline.
    tenantId: z.string().optional(),
  })
  .refine((v) => v.protocol !== "oidc" || (v.clientId && v.clientSecret), { message: "OIDC needs the client ID and client secret issued by the identity provider", path: ["clientId"] });

export const tenantSsoSchema = z.object({
  keycloakIdpAlias: z.string().min(1),
  ssoRequired: z.boolean(),
  autoProvisionUsers: z.boolean(),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
});

// Same rules the tenant's own admin is held to (Pro+ module, not an
// Individual account) - the platform console configures SSO *for* a tenant,
// it doesn't bypass what that tenant is entitled to.
function ssoEligibility(tenant: { accountType: string; subscription: { planKey: string } | null }): { ok: boolean; reason: string | null } {
  if (tenant.accountType === "INDIVIDUAL") return { ok: false, reason: "Individual accounts have a single user - there's no company identity provider to connect." };
  const planKey = (tenant.subscription?.planKey ?? "FREE") as PlanKeyValue;
  if (!planIncludesModule(planKey, MODULE_KEYS.SSO)) return { ok: false, reason: `SSO is a Pro+ feature - this tenant is on ${PLAN_CATALOG[planKey].name}. Change its plan first.` };
  return { ok: true, reason: null };
}

async function loadTenantForSso(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { ssoConfig: true, subscription: true } });
  if (!tenant) throw new NotFoundError("Tenant not found");
  return tenant;
}

export const keycloakService = {
  async overview() {
    const reachable = await keycloakAdmin.reachable();
    return {
      configured: !!env.keycloakUrl && !!env.keycloakRealm,
      adminAccessConfigured: keycloakAdmin.isConfigured(),
      reachable,
      realm: env.keycloakRealm ?? null,
      adminConsoleUrl: keycloakAdmin.adminConsoleUrl(),
      // What the customer's IdP must allow as the redirect/ACS target is the
      // broker endpoint per alias; shown per-IdP in the UI.
      brokerBaseUrl: env.keycloakUrl && env.keycloakRealm ? `${env.keycloakUrl}/realms/${env.keycloakRealm}/broker` : null,
    };
  },

  async listIdps() {
    const [idps, configs] = await Promise.all([
      keycloakAdmin.list(),
      prisma.tenantSsoConfig.findMany({ include: { tenant: { select: { slug: true, name: true } } } }),
    ]);
    const usedBy = (alias: string) => configs.filter((c) => c.keycloakIdpAlias === alias).map((c) => c.tenant);
    const known = new Set(idps.map((i) => i.alias));
    return {
      identityProviders: idps.map((i) => ({ ...i, tenants: usedBy(i.alias) })),
      // A tenant pointing at an alias that no longer exists in Keycloak - its
      // SSO login is broken until an IdP with that alias is registered again.
      brokenTenantConfigs: configs.filter((c) => !known.has(c.keycloakIdpAlias)).map((c) => ({ alias: c.keycloakIdpAlias, tenant: c.tenant })),
    };
  },

  async createIdp(adminId: string, input: CreateIdpInput & { tenantId?: string }) {
    const { tenantId, ...idpInput } = input;
    const idp = await keycloakAdmin.create(idpInput);
    log("keycloak.idp.create", adminId, { alias: idp.alias, protocol: idp.protocol, importUrl: input.importUrl, tenantId });
    if (tenantId && (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      await auditService.record({
        tenantId,
        actorId: null,
        action: "platform.idp_register",
        entityType: "IdentityProvider",
        entityId: idp.alias,
        afterState: { alias: idp.alias, protocol: idp.protocol, platformAdminId: adminId },
      });
    }
    return idp;
  },

  // ----- per-tenant view (Platform Console -> tenant row -> "Single sign-on") -----

  async getTenantSso(tenantId: string) {
    const tenant = await loadTenantForSso(tenantId);
    const overview = await this.overview();
    const canList = overview.reachable && overview.adminAccessConfigured;
    const providers = canList ? (await this.listIdps()).identityProviders : [];
    return {
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      eligibility: ssoEligibility(tenant),
      config: tenant.ssoConfig,
      keycloak: { reachable: overview.reachable, adminAccessConfigured: overview.adminAccessConfigured, brokerBaseUrl: overview.brokerBaseUrl },
      providers,
      suggestedAlias: `${tenant.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-sso`,
    };
  },

  async setTenantSso(adminId: string, tenantId: string, input: z.infer<typeof tenantSsoSchema>) {
    const tenant = await loadTenantForSso(tenantId);
    const eligibility = ssoEligibility(tenant);
    if (!eligibility.ok) throw new BadRequestError(eligibility.reason!);
    // Never point a tenant at an alias Keycloak doesn't have - that would
    // save fine and then fail at every one of its users' sign-ins.
    const existing = await keycloakAdmin.list();
    if (!existing.some((i) => i.alias === input.keycloakIdpAlias)) {
      throw new BadRequestError(`There's no identity provider with alias "${input.keycloakIdpAlias}" in Keycloak - register it first.`);
    }
    return ssoConfigService.upsert(tenantId, input, null, adminId);
  },

  async removeTenantSso(adminId: string, tenantId: string) {
    await loadTenantForSso(tenantId);
    return ssoConfigService.remove(tenantId, null, adminId);
  },

  async deleteIdp(adminId: string, alias: string) {
    const using = await prisma.tenantSsoConfig.findMany({ where: { keycloakIdpAlias: alias }, include: { tenant: { select: { slug: true } } } });
    if (using.length > 0) {
      throw new ConflictError(`Still used by tenant${using.length > 1 ? "s" : ""}: ${using.map((u) => u.tenant.slug).join(", ")}. Remove their SSO configuration first.`);
    }
    await keycloakAdmin.remove(alias);
    log("keycloak.idp.delete", adminId, { alias });
    return { deleted: true };
  },
};
