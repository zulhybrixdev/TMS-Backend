import { prisma } from "./prisma";

const SINGLETON_ID = "singleton";
const CACHE_TTL_MS = 3000; // toggling in the DB takes effect within ~3s across all instances

let cached: { pocMode: boolean; expiresAt: number } | null = null;

// Platform-wide switches, stored as one DB row so ops can flip the live
// site between the POC build and the full build with nothing more than a
// database write - no rebuild, no redeploy, no restart. See
// poc-mode.middleware.ts for where pocMode is actually enforced.
export const platformConfigService = {
  async getPocMode(): Promise<boolean> {
    if (cached && cached.expiresAt > Date.now()) return cached.pocMode;
    const row = await prisma.platformConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    cached = { pocMode: row.pocMode, expiresAt: Date.now() + CACHE_TTL_MS };
    return row.pocMode;
  },

  async setPocMode(pocMode: boolean): Promise<boolean> {
    const row = await prisma.platformConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, pocMode },
      update: { pocMode },
    });
    cached = { pocMode: row.pocMode, expiresAt: Date.now() + CACHE_TTL_MS };
    return row.pocMode;
  },
};
