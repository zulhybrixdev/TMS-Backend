import { prisma } from "./prisma";

// Common Service: human-readable sequential document numbers, e.g.
// PMT-2026-000123 / TRF-2026-000045. Backed by a per-tenant,
// per-prefix-per-year counter row stored in system_settings so numbering
// survives restarts and never collides across tenants.
// MySQL has no RETURNING clause, so the atomic Postgres upsert-and-read
// this used to be (ON CONFLICT ... RETURNING) is done here as an explicit
// transaction: SELECT ... FOR UPDATE row-locks the counter for the
// duration of the transaction, so two concurrent requests for the same
// tenant/counter can't both read-then-write the same value.
async function nextSequence(tenantId: string, counterKey: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO system_settings (tenant_id, \`key\`, value, updated_at)
       VALUES (?, ?, '0', NOW())
       ON DUPLICATE KEY UPDATE tenant_id = tenant_id`,
      tenantId,
      counterKey
    );
    const rows = await tx.$queryRawUnsafe<{ value: string }[]>(
      `SELECT value FROM system_settings WHERE tenant_id = ? AND \`key\` = ? FOR UPDATE`,
      tenantId,
      counterKey
    );
    const next = parseInt(rows[0].value, 10) + 1;
    await tx.$executeRawUnsafe(
      `UPDATE system_settings SET value = ?, updated_at = NOW() WHERE tenant_id = ? AND \`key\` = ?`,
      String(next),
      tenantId,
      counterKey
    );
    return next;
  });
}

export async function generateDocumentNumber(tenantId: string, prefix: "PMT" | "TRF"): Promise<string> {
  const year = new Date().getFullYear();
  const counterKey = `counters.${prefix}.${year}`;
  const seq = await nextSequence(tenantId, counterKey);
  return `${prefix}-${year}-${String(seq).padStart(6, "0")}`;
}
