import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

// Single shared Prisma client instance for the whole app. Explicitly
// imports config/env (rather than letting PrismaClient read
// process.env.DATABASE_URL implicitly) so the connection string is always
// whatever env.ts resolved - regardless of which module happens to import
// this file first, and regardless of import order pulling in dotenv or
// not. Without this, which DATABASE_URL wins depended on import order:
// this file used to construct PrismaClient before anything had loaded
// dotenv, in some entry points (e.g. prisma/seed.ts), so DOTENV_CONFIG_PATH
// (used to point seed/start scripts at .env.production) was silently
// ignored and it connected to whatever DATABASE_URL happened to already be
// in the environment.
export const prisma = new PrismaClient({
  datasources: { db: { url: env.databaseUrl } },
  log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
});
