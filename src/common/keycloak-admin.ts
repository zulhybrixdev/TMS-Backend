import { env } from "../config/env";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "./errors";

// Thin client for the Keycloak Admin REST API, used only by the Platform
// Console's Identity / SSO page. Authenticates as a dedicated service
// account (client-credentials) that can manage identity providers in the
// app's realm and nothing else - not the master admin login.

export type IdpProtocol = "oidc" | "saml";

export interface KeycloakIdp {
  alias: string;
  displayName: string;
  protocol: IdpProtocol | string;
  enabled: boolean;
  trustEmail: boolean;
}

export interface CreateIdpInput {
  alias: string;
  displayName?: string;
  protocol: IdpProtocol;
  // oidc: the IdP's discovery URL (.../.well-known/openid-configuration);
  // saml: the IdP's SAML metadata URL. Keycloak fetches it and fills in
  // endpoints/certificates itself, so nobody pastes those by hand.
  importUrl: string;
  clientId?: string;
  clientSecret?: string;
  trustEmail: boolean;
}

const realmBase = () => `${env.keycloakUrl}/admin/realms/${env.keycloakRealm}`;
let cached: { token: string; expiresAt: number } | null = null;

function isConfigured() {
  return !!(env.keycloakUrl && env.keycloakRealm && env.keycloakAdminClientId && env.keycloakAdminClientSecret);
}

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 15_000) return cached.token;
  const res = await fetch(`${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.keycloakAdminClientId!, client_secret: env.keycloakAdminClientSecret! }),
  }).catch(() => {
    throw new AppError(502, "KEYCLOAK_UNREACHABLE", "Keycloak is not reachable");
  });
  if (!res.ok) throw new AppError(502, "KEYCLOAK_AUTH_FAILED", "Could not authenticate to Keycloak as the platform service account");
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function kc(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isConfigured()) throw new NotFoundError("Keycloak admin access is not configured on this environment");
  const res = await fetch(`${realmBase()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  }).catch(() => {
    throw new AppError(502, "KEYCLOAK_UNREACHABLE", "Keycloak is not reachable");
  });
  return res;
}

async function failWith(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { errorMessage?: string; error?: string };
  // Keycloak answers many failures with a bare "unknown_error" - not useful to a person.
  const message = body.errorMessage ?? (body.error && body.error !== "unknown_error" ? body.error : fallback);
  if (res.status === 409) throw new ConflictError(message);
  if (res.status === 404) throw new NotFoundError(message);
  throw new BadRequestError(message);
}

const toIdp = (i: any): KeycloakIdp => ({ alias: i.alias, displayName: i.displayName || i.alias, protocol: i.providerId, enabled: !!i.enabled, trustEmail: !!i.trustEmail });

export const keycloakAdmin = {
  isConfigured,

  // Where a human goes for anything this page doesn't cover. The bootstrap
  // admin credentials live in keycloak/.env.<tier>, not in this app.
  adminConsoleUrl: () => (env.keycloakUrl ? `${env.keycloakUrl}/admin/master/console/#/${env.keycloakRealm}/identity-providers` : null),

  async reachable(): Promise<boolean> {
    if (!env.keycloakUrl || !env.keycloakRealm) return false;
    try {
      const res = await fetch(`${env.keycloakUrl}/realms/${env.keycloakRealm}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async list(): Promise<KeycloakIdp[]> {
    const res = await kc("/identity-provider/instances");
    if (!res.ok) return failWith(res, "Could not list identity providers");
    return ((await res.json()) as any[]).map(toIdp);
  },

  async create(input: CreateIdpInput): Promise<KeycloakIdp> {
    // Keycloak reads the IdP's metadata itself (endpoints, signing keys).
    const importRes = await kc("/identity-provider/import-config", { method: "POST", body: JSON.stringify({ providerId: input.protocol, fromUrl: input.importUrl }) });
    if (!importRes.ok) return failWith(importRes, `Could not read the ${input.protocol === "saml" ? "SAML metadata" : "OIDC discovery document"} at that URL`);
    const imported = (await importRes.json()) as Record<string, string>;

    const config: Record<string, string> =
      input.protocol === "oidc"
        ? { ...imported, clientId: input.clientId!, clientSecret: input.clientSecret!, useJwksUrl: "true", syncMode: "IMPORT" }
        : {
            ...imported,
            // Sign the user in by email address: with this NameID format
            // Keycloak takes the user's email straight from the assertion.
            nameIDPolicyFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
            principalType: "SUBJECT",
            syncMode: "IMPORT",
          };

    const res = await kc("/identity-provider/instances", {
      method: "POST",
      body: JSON.stringify({
        alias: input.alias,
        displayName: input.displayName || input.alias,
        providerId: input.protocol,
        enabled: true,
        trustEmail: input.trustEmail,
        config,
      }),
    });
    if (!res.ok) return failWith(res, "Could not create the identity provider");
    const created = await kc(`/identity-provider/instances/${encodeURIComponent(input.alias)}`);
    return toIdp(await created.json());
  },

  async remove(alias: string): Promise<void> {
    const res = await kc(`/identity-provider/instances/${encodeURIComponent(alias)}`, { method: "DELETE" });
    if (!res.ok) return failWith(res, "Could not delete the identity provider");
  },
};
