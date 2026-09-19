import { prisma } from "./prisma";

export interface AuditEntry {
  tenantId: string;
  actorId?: string | null;
  action: string; // e.g. "payment.create", "transfer.approve"
  entityType: string; // e.g. "Payment"
  entityId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
}

// Common Service: append-only audit trail. Called from every module that
// mutates treasury data so the system maintains a complete audit history.
export const auditService = {
  async record(entry: AuditEntry) {
    await prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        beforeState: entry.beforeState === undefined ? undefined : (entry.beforeState as any),
        afterState: entry.afterState === undefined ? undefined : (entry.afterState as any),
        ipAddress: entry.ipAddress ?? null,
      },
    });
  },
};
