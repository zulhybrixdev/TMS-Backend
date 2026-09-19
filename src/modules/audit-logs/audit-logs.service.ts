import { prisma } from "../../common/prisma";
import { ParsedListQuery, buildMeta } from "../../common/pagination";

export const auditLogsService = {
  async list(tenantId: string, query: ParsedListQuery, filters: { entityType?: string; actorId?: string; action?: string; from?: string; to?: string }) {
    const where: any = { tenantId };
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.action) where.action = { contains: filters.action };
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, name: true, email: true } } },
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { items: rows, meta: buildMeta(query.page, query.pageSize, total) };
  },

  async distinctEntityTypes(tenantId: string) {
    const rows = await prisma.auditLog.findMany({ where: { tenantId }, distinct: ["entityType"], select: { entityType: true } });
    return rows.map((r) => r.entityType).sort();
  },
};
