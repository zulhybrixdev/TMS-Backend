import { Prisma, TenantAccountType } from "@prisma/client";
import { prisma } from "./prisma";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_CATALOG, ROLE_NAMES } from "./permissions";
import { PLAN_KEYS, PlanKeyValue } from "./plans";

type TxClient = Prisma.TransactionClient;

// Shared by self-service registration (auth.service) and the seed script:
// every tenant gets its own copy of the 5 system roles (cloned from the
// DEFAULT_ROLE_PERMISSIONS catalog) so each tenant's Admin can edit its
// roles independently of every other tenant's.
export async function seedTenantRoles(tx: TxClient, tenantId: string): Promise<Map<string, string>> {
  const permissions = await tx.permission.findMany();
  const permissionByCode = new Map(permissions.map((p) => [p.code, p.id]));

  const roleIdByName = new Map<string, string>();
  for (const roleName of Object.values(ROLE_NAMES)) {
    const codes = DEFAULT_ROLE_PERMISSIONS[roleName] ?? [];
    const role = await tx.role.create({
      data: {
        tenantId,
        name: roleName,
        description: `${roleName} - system role`,
        isSystem: true,
        permissions: { create: codes.map((code) => ({ permissionId: permissionByCode.get(code)! })) },
      },
    });
    roleIdByName.set(roleName, role.id);
  }
  return roleIdByName;
}

// Idempotent: the global permission catalog is shared by every tenant (see
// schema.prisma - Permission has no tenantId). Diffs against what's already
// seeded rather than a one-time "table empty?" check, so a code added to
// PERMISSION_CATALOG later (e.g. a new module) gets inserted into an
// already-provisioned database too, instead of silently never existing.
export async function ensurePermissionCatalogSeeded(tx: TxClient) {
  const existing = await tx.permission.findMany({ select: { code: true } });
  const existingCodes = new Set(existing.map((p) => p.code));
  const missing = PERMISSION_CATALOG.filter((p) => !existingCodes.has(p.code));
  if (missing.length === 0) return;
  await tx.permission.createMany({
    data: missing.map((p) => ({ code: p.code, module: p.module, description: p.description })),
  });
}

// A new permission code added to DEFAULT_ROLE_PERMISSIONS reaches brand-new
// tenants automatically (seedTenantRoles clones the catalog fresh at
// provisioning time) but never reaches already-provisioned tenants' system
// roles - roles.service.ts blocks editing a system role's permissions
// entirely (`isSystem` check), so there was no path for it to happen even
// by hand. This is the missing other half of ensurePermissionCatalogSeeded
// above: run once at boot (see index.ts) across every tenant, additive-only
// (only ever grants a missing default permission, never revokes one -
// system roles can't gain anything else since edits are blocked, so
// "missing" always means "added to the catalog after this tenant was
// provisioned", not "someone customised it").
export async function syncSystemRolePermissions(): Promise<{ tenantsChecked: number; permissionsGranted: number }> {
  const permissions = await prisma.permission.findMany();
  const permissionByCode = new Map(permissions.map((p) => [p.code, p.id]));

  const systemRoles = await prisma.role.findMany({
    where: { isSystem: true, name: { in: Object.values(ROLE_NAMES) } },
    include: { permissions: { select: { permissionId: true } } },
  });

  let permissionsGranted = 0;
  const tenantIds = new Set<string>();
  for (const role of systemRoles) {
    tenantIds.add(role.tenantId);
    const defaultCodes = DEFAULT_ROLE_PERMISSIONS[role.name] ?? [];
    const currentIds = new Set(role.permissions.map((rp) => rp.permissionId));
    const missing = defaultCodes.map((code) => permissionByCode.get(code)).filter((id): id is string => !!id && !currentIds.has(id));
    if (missing.length === 0) continue;

    await prisma.rolePermission.createMany({
      data: missing.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
    permissionsGranted += missing.length;
  }

  return { tenantsChecked: tenantIds.size, permissionsGranted };
}

function slugify(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "TENANT"
  );
}

// Generates a unique tenant slug from a company name (e.g. "Acme Sdn Bhd" ->
// "ACME-SDN-BHD", retrying with a numeric suffix on collision).
export async function generateUniqueTenantSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  while (await prisma.tenant.findUnique({ where: { slug: candidate } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export interface ProvisionTenantInput {
  slug: string;
  name: string;
  accountType: TenantAccountType;
  planKey: PlanKeyValue;
}

// Creates a Tenant + its role set + a Subscription row. FREE activates
// immediately; PRO/PRO_PLUS start PENDING_PAYMENT until the Fiuu checkout
// completes (see billing module).
export async function provisionTenant(tx: TxClient, input: ProvisionTenantInput) {
  await ensurePermissionCatalogSeeded(tx);

  const tenant = await tx.tenant.create({
    data: { slug: input.slug, name: input.name, accountType: input.accountType },
  });

  const roleIdByName = await seedTenantRoles(tx, tenant.id);

  const isFree = input.planKey === PLAN_KEYS.FREE;
  const subscription = await tx.subscription.create({
    data: {
      tenantId: tenant.id,
      planKey: input.planKey,
      status: isFree ? "ACTIVE" : "PENDING_PAYMENT",
      currentPeriodStart: isFree ? new Date() : null,
      currentPeriodEnd: null,
    },
  });

  return { tenant, roleIdByName, subscription };
}
