import bcrypt from "bcryptjs";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { ConflictError, LimitReachedError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";
import { PLAN_CATALOG, PLAN_KEYS, PlanKeyValue } from "../../common/plans";

const userInclude = { roles: { include: { role: true } } };

function serialize(user: any) {
  const { passwordHash, roles, ...rest } = user;
  return { ...rest, roles: roles.map((ur: any) => ({ id: ur.role.id, name: ur.role.name })) };
}

// Enforces the tenant's account-type seat cap (Individual is always capped
// at 1 user, regardless of plan) plus the current plan's user limit.
async function assertSeatAvailable(tenantId: string) {
  const [tenant, subscription, currentUserCount] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.subscription.findUnique({ where: { tenantId } }),
    prisma.user.count({ where: { tenantId, deletedAt: null } }),
  ]);

  if (tenant.accountType === "INDIVIDUAL" && currentUserCount >= 1) {
    throw new LimitReachedError("Individual accounts are limited to a single user. Switch to Team or Enterprise to add more.");
  }

  const planKey = (subscription?.planKey ?? PLAN_KEYS.FREE) as PlanKeyValue;
  const limit = PLAN_CATALOG[planKey].limits.users;
  if (limit !== null && currentUserCount >= limit) {
    throw new LimitReachedError(`Your ${PLAN_CATALOG[planKey].name} plan is limited to ${limit} users. Upgrade to add more.`);
  }
}

export const usersService = {
  // Distinct, non-empty departments already in use in this tenant - backs
  // the approval rule form's department picklist so it's an autocomplete
  // against real values instead of pure free text (still allows typing a
  // brand-new department that no user has yet, e.g. defining routing ahead
  // of hiring into it).
  async listDepartments(tenantId: string): Promise<string[]> {
    const rows = await prisma.user.findMany({
      where: { tenantId, deletedAt: null, department: { not: null } },
      select: { department: true },
      distinct: ["department"],
      orderBy: { department: "asc" },
    });
    return rows.map((r) => r.department!).filter(Boolean);
  },

  async list(tenantId: string, query: ParsedListQuery, filters: { status?: string; roleId?: string }) {
    const where: any = { tenantId, deletedAt: null };
    if (filters.status) where.status = filters.status;
    if (filters.roleId) where.roles = { some: { roleId: filters.roleId } };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { email: { contains: query.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: userInclude,
        skip: query.skip,
        take: query.take,
        orderBy: { [query.sortBy ?? "createdAt"]: query.sortDir },
      }),
      prisma.user.count({ where }),
    ]);

    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const user = await prisma.user.findFirst({ where: { id, tenantId, deletedAt: null }, include: userInclude });
    if (!user) throw new NotFoundError("User not found");
    return serialize(user);
  },

  async create(tenantId: string, input: { email: string; name: string; jobTitle?: string; department?: string; password: string; roleIds: string[] }, actorId: string) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictError("A user with this email already exists");

    await assertSeatAvailable(tenantId);

    const passwordHash = await bcrypt.hash(input.password, env.bcryptSaltRounds);
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: input.email,
        name: input.name,
        jobTitle: input.jobTitle,
        department: input.department,
        passwordHash,
        roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
      },
      include: userInclude,
    });

    await auditService.record({ tenantId, actorId, action: "user.create", entityType: "User", entityId: user.id, afterState: serialize(user) });
    return serialize(user);
  },

  async update(tenantId: string, id: string, input: { name?: string; jobTitle?: string; department?: string; status?: string; roleIds?: string[] }, actorId: string) {
    const before = await prisma.user.findFirst({ where: { id, tenantId, deletedAt: null }, include: userInclude });
    if (!before) throw new NotFoundError("User not found");

    const user = await prisma.$transaction(async (tx) => {
      if (input.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId: id, roleId })) });
      }
      return tx.user.update({
        where: { id },
        data: { name: input.name, jobTitle: input.jobTitle, department: input.department, status: input.status as any },
        include: userInclude,
      });
    });

    await auditService.record({
      tenantId,
      actorId,
      action: "user.update",
      entityType: "User",
      entityId: id,
      beforeState: serialize(before),
      afterState: serialize(user),
    });
    return serialize(user);
  },

  async resetPassword(tenantId: string, id: string, newPassword: string, actorId: string) {
    const user = await prisma.user.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!user) throw new NotFoundError("User not found");
    const passwordHash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    await auditService.record({ tenantId, actorId, action: "user.reset_password", entityType: "User", entityId: id });
    return { reset: true };
  },

  async softDelete(tenantId: string, id: string, actorId: string) {
    const user = await prisma.user.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!user) throw new NotFoundError("User not found");
    await prisma.user.update({ where: { id }, data: { status: "INACTIVE", deletedAt: new Date() } });
    await auditService.record({ tenantId, actorId, action: "user.deactivate", entityType: "User", entityId: id });
    return { deactivated: true };
  },
};
