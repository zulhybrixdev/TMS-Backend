import { prisma } from "./prisma";

const SINGLETON_ID = "singleton";
const CACHE_TTL_MS = 3000; // toggling in the DB takes effect within ~3s across all instances

export interface PlatformConfigValues {
  pocMode: boolean;
  registrationEnabled: boolean;
}

let cached: { values: PlatformConfigValues; expiresAt: number } | null = null;

const toValues = (row: { pocMode: boolean; registrationEnabled: boolean }): PlatformConfigValues => ({ pocMode: row.pocMode, registrationEnabled: row.registrationEnabled });
const remember = (values: PlatformConfigValues) => {
  cached = { values, expiresAt: Date.now() + CACHE_TTL_MS };
  return values;
};

// Platform-wide switches, stored as one DB row so ops can flip the live
// site between the POC build and the full build - or close self-service
// registration - with nothing more than a database write: no rebuild, no
// redeploy, no restart. See poc-mode.middleware.ts for where pocMode is
// enforced and auth.routes.ts (requireRegistrationOpen) for registration.
export const platformConfigService = {
  async get(): Promise<PlatformConfigValues> {
    if (cached && cached.expiresAt > Date.now()) return cached.values;
    const row = await prisma.platformConfig.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID }, update: {} });
    return remember(toValues(row));
  },

  async getPocMode(): Promise<boolean> {
    return (await this.get()).pocMode;
  },

  async isRegistrationEnabled(): Promise<boolean> {
    return (await this.get()).registrationEnabled;
  },

  async setPocMode(pocMode: boolean): Promise<PlatformConfigValues> {
    const row = await prisma.platformConfig.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID, pocMode }, update: { pocMode } });
    return remember(toValues(row));
  },

  async setRegistrationEnabled(registrationEnabled: boolean): Promise<PlatformConfigValues> {
    const row = await prisma.platformConfig.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID, registrationEnabled }, update: { registrationEnabled } });
    return remember(toValues(row));
  },
};
