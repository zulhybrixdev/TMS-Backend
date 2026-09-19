import dotenv from "dotenv";

// Explicit call (not the "dotenv/config" side-effect-import shortcut) so
// DOTENV_CONFIG_PATH is honoured deterministically and always wins over
// whatever's already in process.env - needed so start:production/
// seed:production (DOTENV_CONFIG_PATH=.env.production) reliably load that
// file instead of the default .env, regardless of which module happens to
// import this file first elsewhere in the app.
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || ".env", override: true });

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  port: parseInt(process.env.PORT ?? "4417", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3417",
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "8h",

  // Max secret-checking attempts (login, register, MFA, change-password)
  // per IP per 15 minutes - see common/middleware/rate-limit.middleware.ts.
  rateLimitAuthMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? "30", 10),

  // TOTP MFA secrets-at-rest encryption key (see common/mfa-crypto.ts) -
  // hashed down to a 32-byte AES-256-GCM key, so any string works here,
  // same convention as jwtSecret above. MFA itself is opt-in per user
  // (User.totpEnabled defaults to false) so this only matters once a
  // tenant actually starts using it.
  mfaEncryptionKey: required("MFA_ENCRYPTION_KEY", "dev-only-mfa-key-change-me"),
  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS ?? "10", 10),
  isProduction: process.env.NODE_ENV === "production",

  // Public URL of the frontend app, used to build Fiuu return/notification
  // URLs and the dummy-checkout fallback link. Defaults to corsOrigin.
  appUrl: process.env.APP_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:3417",

  // Fiuu payment gateway (subscription billing). Leave unset to run the
  // built-in dummy checkout simulator instead of real Fiuu redirects - see
  // billing/fiuu-client.ts.
  fiuuMerchantId: process.env.FIUU_MERCHANT_ID,
  fiuuVerifyKey: process.env.FIUU_VERIFY_KEY,
  fiuuEnvironment: (process.env.FIUU_ENVIRONMENT as "sandbox" | "production") ?? "sandbox",

  // Twelve Data (intraday/live FX rates - see modules/fx/fx-provider.ts).
  // Leave unset to fall back to the daily Frankfurter reference rate
  // automatically, same "real if configured, graceful fallback if not"
  // convention as Fiuu above.
  twelveDataApiKey: process.env.TWELVEDATA_API_KEY,

  // Keycloak SSO broker (dev tier only for now - see keycloak/ at the repo
  // root and modules/auth/sso.routes.ts). Same "real if configured, no-op
  // otherwise" convention as Fiuu/Twelve Data above: leave unset and the
  // /auth/sso/* routes simply 404 instead of erroring - local password
  // login (auth.service.ts) is entirely unaffected either way.
  keycloakUrl: process.env.KEYCLOAK_URL,
  keycloakRealm: process.env.KEYCLOAK_REALM,
  keycloakClientId: process.env.KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
  // Least-privilege service account (identity-provider management in the
  // app's realm only) for the Platform Console's Identity / SSO page - see
  // keycloak/provision-platform-client.sh. Never the master admin login.
  keycloakAdminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID,
  keycloakAdminClientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET,
  // Must exactly match the redirect URI registered on the Keycloak client
  // (see keycloak/README-ish setup notes) - defaults to this tier's own
  // port since the backend itself (not the frontend) handles the callback.
  keycloakRedirectUri: process.env.KEYCLOAK_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? "4417"}/api/auth/sso/callback`,

  // Which deployment tier this running instance is. "uat" (default, and
  // also what the local dev backend runs as - see .env.development) serves
  // both the full app (/) and the POC build (/poc), switchable live via
  // PlatformConfig.pocMode - see poc-mode.middleware.ts. "production" never
  // mounts /poc or that redirect at all, so real clients can never end up
  // on the POC build no matter what the DB flag says. /platform is
  // reachable on every tier, always. Every tier - dev, uat, production -
  // has its own port, database, and env file so they can all run at the
  // same time without colliding (deliberately uncommon ports - see
  // .env.example): 2417 = dev backend, 3417 = frontend's own Vite dev
  // server (a separate local-only concern), 4417 = uat/poc, 5417 = prod.
  deployEnv: (process.env.DEPLOY_ENV as "uat" | "production") ?? "uat",

  // Purely a UI label (GET /api/meta, see index.ts) so the frontend can
  // show which tier it's actually talking to - deployEnv above can't do
  // this alone since dev and uat both report "uat" (dev intentionally
  // mirrors uat's /poc-redirect behaviour). Not used for any access
  // control or environment-branching logic, only display.
  tierLabel: process.env.TIER_LABEL ?? "UAT",
};
