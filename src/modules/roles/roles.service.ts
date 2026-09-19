import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

const roleInclude = { permissions: { include: { permission: true } }, _count: { select: { users: true } } };

function serialize(role: any) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    userCount: role._count?.users ?? 0,
    permissions: role.permissions.map((rp: any) => rp.permission.code),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export const rolesService = {
  async list(tenantId: string) {
    const roles = await prisma.role.findMany({ where: { tenantId }, include: roleInclude, orderBy: { name: "asc" } });
    return roles.map(serialize);
  },

  async getById(tenantId: string, id: string) {
    const role = await prisma.role.findFirst({ where: { id, tenantId }, include: roleInclude });
    if (!role) throw new NotFoundError("Role not found");
    return serialize(role);
  },

  async listPermissions() {
    return prisma.permission.findMany({ orderBy: [{ module: "asc" }, { code: "asc" }] });
  },

  async create(tenantId: string, input: { name: string; description?: string; permissionCodes: string[] }, actorId: string) {
    const existing = await prisma.role.findUnique({ where: { tenantId_name: { tenantId, name: input.name } } });
    if (existing) throw new ConflictError("A role with this name already exists");

    const permissions = await prisma.permission.findMany({ where: { code: { in: input.permissionCodes } } });
    const role = await prisma.role.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description,
        permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
      },
      include: roleInclude,
    });

    await auditService.record({ tenantId, actorId, action: "role.create", entityType: "Role", entityId: role.id, afterState: serialize(role) });
    return serialize(role);
  },

  async update(tenantId: string, id: string, input: { name?: string; description?: string; permissionCodes?: string[] }, actorId: string) {
    const before = await prisma.role.findFirst({ where: { id, tenantId }, include: roleInclude });
    if (!before) throw new NotFoundError("Role not found");
    if (before.isSystem && input.permissionCodes) {
      throw new ConflictError("System roles cannot have permissions edited");
    }

    const role = await prisma.$transaction(async (tx) => {
      if (input.permissionCodes) {
        const permissions = await tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: id, permissionId: p.id })) });
      }
      return tx.role.update({
        where: { id },
        data: { name: input.name, description: input.description },
        include: roleInclude,
      });
    });

    await auditService.record({
      tenantId,
      actorId,
      action: "role.update",
      entityType: "Role",
      entityId: id,
      beforeState: serialize(before),
      afterState: serialize(role),
    });
    return serialize(role);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const role = await prisma.role.findFirst({ where: { id, tenantId }, include: roleInclude });
    if (!role) throw new NotFoundError("Role not found");
    if (role.isSystem) throw new ConflictError("System roles cannot be deleted");
    if ((role._count?.users ?? 0) > 0) throw new ConflictError("Role is assigned to users and cannot be deleted");

    await prisma.role.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "role.delete", entityType: "Role", entityId: id, beforeState: serialize(role) });
    return { deleted: true };
  },
};
