import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { NotFoundError, UnauthorizedError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { loadAuthUser, signTenantToken } from "../../common/auth-token";
import { ROLE_NAMES } from "../../common/permissions";
import { PLAN_CATALOG, PLAN_KEYS, PlanKeyValue } from "../../common/plans";
import { auditLogsService } from "../audit-logs/audit-logs.service";
import { ParsedListQuery } from "../../common/pagination";

function signPlatformToken(admin: { id: string; email: string; name: string }) {
  return jwt.sign({ id: admin.id, email: admin.email, name: admin.name, scope: "platform" }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

async function serializeTenant(tenantId: string) {
  const [tenant, userCount, bankAccountCount] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { subscription: true } }),
    prisma.user.count({ where: { tenantId, deletedAt: null } }),
    prisma.bankAccount.count({ where: { tenantId, deletedAt: null } }),
  ]);
  const planKey = (tenant.subscription?.planKey ?? PLAN_KEYS.FREE) as PlanKeyValue;
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    accountType: tenant.accountType,
    status: tenant.status,
    createdAt: tenant.createdAt,
    subscription: tenant.subscription
      ? {
          planKey: tenant.subscription.planKey,
          plan: PLAN_CATALOG[planKey],
          status: tenant.subscription.status,
          currentPeriodStart: tenant.subscription.currentPeriodStart,
          currentPeriodEnd: tenant.subscription.currentPeriodEnd,
        }
      : null,
    usage: { users: userCount, bankAccounts: bankAccountCount },
  };
}

// Platform Service: cross-tenant oversight for the dedicated platform-admin
// account (see platform-auth.middleware.ts). Two tiers: listTenants/
// getTenant/setStatus/setSubscription work on tenant metadata only (plan,
// status, seat counts) without ever touching a tenant's own treasury data;
// impersonateTenant is the "overseer everything" escape hatch into the
// tenant's actual data via its own app. Every state-changing action here is
// audit-logged under the affected tenant, alongside that tenant's own
// activity, so getTenantAuditLog shows one combined timeline of what the
// tenant's users did and what platform support did to them.
export const platformService = {
  async login(email: string, password: string) {
    const admin = await prisma.platformAdmin.findUnique({ where: { email } });
    if (!admin) throw new UnauthorizedError("Invalid email or password");
    const validPassword = await bcrypt.compare(password, admin.passwordHash);
    if (!validPassword) throw new UnauthorizedError("Invalid email or password");

    const token = signPlatformToken(admin);
    return { token, admin: { id: admin.id, email: admin.email, name: admin.name } };
  },

  async me(id: string) {
    const admin = await prisma.platformAdmin.findUniqueOrThrow({ where: { id } });
    return { id: admin.id, email: admin.email, name: admin.name };
  },

  async listTenants() {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: "desc" } });
    return Promise.all(tenants.map((t) => serializeTenant(t.id)));
  },

  async getTenant(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundError("Tenant not found");
    const [detail, invoices] = await Promise.all([
      serializeTenant(id),
      prisma.subscriptionInvoice.findMany({ where: { tenantId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    return { ...detail, invoices };
  },

  async setStatus(platformAdminId: string, id: string, status: "ACTIVE" | "SUSPENDED") {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundError("Tenant not found");
    await prisma.tenant.update({ where: { id }, data: { status } });
    await auditService.record({
      tenantId: id,
      actorId: null,
      action: status === "SUSPENDED" ? "platform.tenant_suspend" : "platform.tenant_activate",
      entityType: "Tenant",
      entityId: id,
      beforeState: { status: tenant.status },
      afterState: { status, platformAdminId },
    });
    return serializeTenant(id);
  },

  // Every audit_logs row for this tenant - both what its own users did and
  // every platform-admin action recorded above/below, interleaved by time.
  async getTenantAuditLog(tenantId: string, query: ParsedListQuery) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError("Tenant not found");
    return auditLogsService.list(tenantId, query, {});
  },

  // "Overseer everything" - mints a normal tenant JWT for that tenant's
  // (oldest) active Admin user, tagged with impersonatedByPlatformAdminId so
  // requireModule() and the suspended-tenant block both step aside (see
  // plan.middleware.ts / tenant.middleware.ts). The resulting session is
  // otherwise indistinguishable from that Admin's own login - it reuses
  // every existing tenant page/API, so nothing about the tenant is hidden.
  // Every impersonation is audit-logged under the target tenant.
  async impersonateTenant(platformAdminId: string, tenantId: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError("Tenant not found");

    const adminUser = await prisma.user.findFirst({
      where: { tenantId, status: "ACTIVE", deletedAt: null, roles: { some: { role: { name: ROLE_NAMES.ADMIN, tenantId } } } },
      orderBy: { createdAt: "asc" },
    });
    if (!adminUser) throw new NotFoundError("This tenant has no active Admin user to view as");

    const authUser = await loadAuthUser(adminUser.id);
    const token = signTenantToken(authUser, { impersonatedByPlatformAdminId: platformAdminId });

    await auditService.record({
      tenantId,
      actorId: null,
      action: "platform.impersonate_start",
      entityType: "Tenant",
      entityId: tenantId,
      afterState: { platformAdminId, viewingAsUserId: adminUser.id, viewingAsEmail: adminUser.email },
    });

    return { token, user: authUser, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } };
  },

  // Manual override - comp a customer onto a paid plan, or roll one back
  // after a failed/refunded payment - without going through Fiuu checkout.
  async setSubscription(platformAdminId: string, id: string, input: { planKey: PlanKeyValue; status?: "ACTIVE" | "PAST_DUE" | "CANCELED" | "PENDING_PAYMENT" }) {
    const tenant = await prisma.tenant.findUnique({ where: { id }, include: { subscription: true } });
    if (!tenant) throw new NotFoundError("Tenant not found");

    const status = input.status ?? "ACTIVE";
    const isActivating = status === "ACTIVE";
    await prisma.subscription.upsert({
      where: { tenantId: id },
      create: {
        tenantId: id,
        planKey: input.planKey,
        status,
        currentPeriodStart: isActivating ? new Date() : null,
        currentPeriodEnd: isActivating ? new Date(Date.now() + 30 * 86400000) : null,
      },
      update: {
        planKey: input.planKey,
        status,
        ...(isActivating ? { currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } : {}),
      },
    });
    await auditService.record({
      tenantId: id,
      actorId: null,
      action: "platform.subscription_override",
      entityType: "Subscription",
      entityId: id,
      beforeState: tenant.subscription ? { planKey: tenant.subscription.planKey, status: tenant.subscription.status } : null,
      afterState: { planKey: input.planKey, status, platformAdminId },
    });
    return serializeTenant(id);
  },
};
