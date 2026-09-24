import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";

const CACHE_TTL_MS = 5000; // a new/ended announcement reaches every user within a few seconds
let activeCache: { rows: ReturnType<typeof serialize>[]; expiresAt: number } | null = null;
const clearCache = () => (activeCache = null);

const SEVERITY: Record<string, number> = { DOWNTIME: 0, MAINTENANCE: 1, INFO: 2 };

// The moment the lock (if any) applies: the affected window when one is set,
// otherwise the whole time the announcement is live. It only ever counts while
// the announcement itself is live, so ending or deleting one lifts the lock.
function lockWindow(row: any) {
  return { from: (row.affectedFrom ?? row.startsAt) as Date, until: (row.affectedTo ?? row.endsAt) as Date };
}
function isLockedNow(row: any, now: Date) {
  if (!row.blocking || row.type === "INFO") return false;
  if (!(row.startsAt <= now && row.endsAt > now)) return false;
  const w = lockWindow(row);
  return w.from <= now && w.until > now;
}

function serialize(row: any) {
  const now = new Date();
  const locked = isLockedNow(row, now);
  return {
    id: row.id,
    type: row.type as "INFO" | "MAINTENANCE" | "DOWNTIME",
    titleEn: row.titleEn as string,
    titleMs: (row.titleMs ?? null) as string | null,
    messageEn: row.messageEn as string,
    messageMs: (row.messageMs ?? null) as string | null,
    startsAt: row.startsAt as Date,
    endsAt: row.endsAt as Date,
    affectedFrom: (row.affectedFrom ?? null) as Date | null,
    affectedTo: (row.affectedTo ?? null) as Date | null,
    persistent: row.persistent as boolean,
    blocking: (row.blocking ?? false) as boolean,
    /** True while the system is locked by this announcement right now (computed on the server, so clients need no clock). */
    locked,
    lockedUntil: (locked ? lockWindow(row).until : null) as Date | null,
  };
}

const log = (action: string, adminId: string | undefined, detail: Record<string, unknown>) =>
  // Platform-level actions aren't tenant-scoped, so (like the other platform actions) they are recorded as structured log lines.
  // eslint-disable-next-line no-console
  console.info("[platform-audit]", JSON.stringify({ at: new Date().toISOString(), action, platformAdminId: adminId, ...detail }));

// Platform-wide announcements. Shown to every user of this environment
// (signed in or not) while now is between startsAt and endsAt.
export const announcementsService = {
  // Public: what the banner shows right now. Most severe first.
  async listActive() {
    if (activeCache && activeCache.expiresAt > Date.now()) return activeCache.rows;
    const now = new Date();
    const rows = await prisma.announcement.findMany({ where: { startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { createdAt: "desc" } });
    const sorted = rows.map(serialize).sort((a, b) => SEVERITY[a.type] - SEVERITY[b.type]);
    activeCache = { rows: sorted, expiresAt: Date.now() + CACHE_TTL_MS };
    return sorted;
  },

  // The announcement currently locking the system, if any (most severe first).
  async getActiveLock() {
    return (await this.listActive()).find((a) => a.locked) ?? null;
  },

  // Platform Console: everything recent, with a status.
  async listAll() {
    const rows = await prisma.announcement.findMany({ orderBy: { startsAt: "desc" }, take: 100 });
    const now = Date.now();
    return rows.map((r) => ({ ...serialize(r), createdAt: r.createdAt, status: r.endsAt.getTime() <= now ? "ENDED" : r.startsAt.getTime() > now ? "SCHEDULED" : "LIVE" }));
  },

  async create(input: any, adminId: string) {
    const row = await prisma.announcement.create({ data: { ...input, createdById: adminId } });
    clearCache();
    log("platform.announcement.create", adminId, { id: row.id, type: row.type, startsAt: row.startsAt, endsAt: row.endsAt, persistent: row.persistent });
    return serialize(row);
  },

  async update(id: string, input: any, adminId: string) {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Announcement not found");
    const row = await prisma.announcement.update({ where: { id }, data: input });
    clearCache();
    log("platform.announcement.update", adminId, { id });
    return serialize(row);
  },

  // Stop showing it now, keeping the record.
  async endNow(id: string, adminId: string) {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Announcement not found");
    const now = new Date();
    const row = await prisma.announcement.update({ where: { id }, data: { endsAt: existing.startsAt > now ? existing.startsAt : now } });
    clearCache();
    log("platform.announcement.end", adminId, { id });
    return serialize(row);
  },

  async remove(id: string, adminId: string) {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Announcement not found");
    await prisma.announcement.delete({ where: { id } });
    clearCache();
    log("platform.announcement.delete", adminId, { id });
    return { deleted: true };
  },
};
