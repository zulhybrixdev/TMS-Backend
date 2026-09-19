import crypto from "crypto";
import jwt from "jsonwebtoken";
import * as jose from "jose";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { NotFoundError, TenantSuspendedError, UnauthorizedError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { loadAuthUser, signTenantToken } from "../../common/auth-token";
import { ROLE_NAMES } from "../../common/permissions";
import { MODULE_KEYS, PlanKeyValue, planIncludesModule } from "../../common/plans";

function isConfigured(): boolean {
  return !!(env.keycloakUrl && env.keycloakRealm && env.keycloakClientId && env.keycloakClientSecret);
}

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(`${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/certs`));
  }
  return jwks;
}

// Everything the callback needs to trust, generated at /start and carried in
// a short-lived signed HttpOnly cookie in the *same browser* - so a callback
// only completes for the browser that started the login (this is the CSRF /
// login-fixation defence the OAuth `state` parameter exists for), and the
// PKCE verifier + ID-token nonce never leave the server/browser pair.
const SSO_STATE_PURPOSE = "sso_state";
export const SSO_STATE_COOKIE = `tms_sso_${env.port}`; // port-suffixed: dev/uat/prod share the host "localhost"
export const SSO_STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface SsoStatePayload {
  purpose: string;
  tenantSlug: string;
  state: string;
  verifier: string;
  nonce: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

// SSO is a Pro+ module: a tenant that downgraded keeps its TenantSsoConfig
// row, but can't use it until it upgrades again.
function assertTenantMaySso(tenant: { status: string; subscription: { planKey: string } | null }) {
  if (tenant.status === "SUSPENDED") throw new TenantSuspendedError();
  if (!tenant.subscription || !planIncludesModule(tenant.subscription.planKey as PlanKeyValue, MODULE_KEYS.SSO)) {
    throw new NotFoundError("SSO isn't available on this organisation's current plan");
  }
}

function allowedDomains(config: { allowedEmailDomains: unknown }): string[] {
  return Array.isArray(config.allowedEmailDomains) ? (config.allowedEmailDomains as string[]).map((d) => d.trim().toLowerCase()).filter(Boolean) : [];
}

export const ssoService = {
  isConfigured,

  // Step 1: send the browser to Keycloak, hinting which of that realm's
  // registered Identity Providers to federate through - this is what
  // makes it "this tenant's SSO", not a generic Keycloak login screen.
  // A TenantSsoConfig row existing is the gate (its creation was already
  // gated - Pro+, accountType != INDIVIDUAL - in sso-config.service.ts) plus
  // the plan/suspension re-check here, since the entry point is public and
  // pre-auth and can't use requireModule against a caller who isn't logged in.
  async startAuthorization(tenantSlug: string): Promise<{ url: string; cookieValue: string }> {
    if (!isConfigured()) throw new NotFoundError("SSO is not configured");
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, include: { ssoConfig: true, subscription: true } });
    if (!tenant?.ssoConfig) throw new NotFoundError("SSO is not configured for this tenant");
    assertTenantMaySso(tenant);

    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

    const url = new URL(`${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/auth`);
    url.searchParams.set("client_id", env.keycloakClientId!);
    url.searchParams.set("redirect_uri", env.keycloakRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("kc_idp_hint", tenant.ssoConfig.keycloakIdpAlias);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const payload: SsoStatePayload = { purpose: SSO_STATE_PURPOSE, tenantSlug: tenant.slug, state, verifier, nonce };
    const cookieValue = jwt.sign(payload, env.jwtSecret, { expiresIn: Math.floor(SSO_STATE_MAX_AGE_MS / 1000) });
    return { url: url.toString(), cookieValue };
  },

  // Step 2: check the callback belongs to the login this browser started,
  // exchange the code (with the PKCE verifier), and validate the ID token
  // against Keycloak's OWN JWKS (the broker realm's, not the external IdP's)
  // - the concrete benefit of brokering: whatever protocol a tenant's real
  // IdP speaks, this backend only ever trusts one issuer.
  async handleCallback(input: { code: string; state: string; cookieValue: string | undefined; ipAddress?: string }) {
    if (!isConfigured()) throw new NotFoundError("SSO is not configured");

    let saved: SsoStatePayload;
    try {
      saved = jwt.verify(input.cookieValue ?? "", env.jwtSecret) as SsoStatePayload;
    } catch {
      throw new UnauthorizedError("Your sign-in session expired or was started in a different browser - please try again");
    }
    const a = Buffer.from(saved.state);
    const b = Buffer.from(input.state);
    if (saved.purpose !== SSO_STATE_PURPOSE || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedError("SSO sign-in could not be verified - please try again");
    }

    const tokenRes = await fetch(`${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: env.keycloakRedirectUri,
        client_id: env.keycloakClientId!,
        client_secret: env.keycloakClientSecret!,
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenRes.ok) throw new UnauthorizedError("Keycloak rejected the authorization code");
    const tokenBody = (await tokenRes.json()) as { id_token: string };

    const { payload } = await jose.jwtVerify(tokenBody.id_token, getJwks(), {
      issuer: `${env.keycloakUrl}/realms/${env.keycloakRealm}`,
      audience: env.keycloakClientId!,
    });
    if (payload.nonce !== saved.nonce) throw new UnauthorizedError("SSO sign-in could not be verified - please try again");

    const rawEmail = payload.email as string | undefined;
    if (!rawEmail) throw new UnauthorizedError("Identity provider did not return an email address");
    // An unverified email is just a claim anyone could make - and we match
    // it to existing accounts (including Admins) by address.
    if (payload.email_verified !== true) throw new UnauthorizedError("Your identity provider hasn't verified this email address, so it can't be used to sign in");
    const email = rawEmail.trim().toLowerCase();

    // Tenant comes from the server-signed cookie, never from anything the IdP says.
    const tenant = await prisma.tenant.findUnique({ where: { slug: saved.tenantSlug }, include: { ssoConfig: true, subscription: true } });
    if (!tenant?.ssoConfig) throw new NotFoundError("SSO is not configured for this tenant");
    assertTenantMaySso(tenant);

    const domains = allowedDomains(tenant.ssoConfig);
    if (domains.length > 0 && !domains.includes(email.split("@")[1] ?? "")) {
      throw new UnauthorizedError("Your email address isn't from a domain this organisation allows for SSO");
    }

    // Emails are unique across the whole platform (one email = one account),
    // so look globally - a match in another tenant must not be signed into
    // (or collide on create).
    let user = await prisma.user.findUnique({ where: { email } });
    if (user && user.tenantId !== tenant.id) {
      throw new UnauthorizedError("This email address is already registered with a different organisation");
    }
    if (user && (user.deletedAt || user.status !== "ACTIVE")) {
      throw new UnauthorizedError("This account is not active");
    }

    if (!user) {
      if (!tenant.ssoConfig.autoProvisionUsers) {
        throw new UnauthorizedError("Your account hasn't been created yet - ask your admin to invite you first");
      }
      const viewerRole = await prisma.role.findFirst({ where: { tenantId: tenant.id, name: ROLE_NAMES.VIEWER } });
      if (!viewerRole) throw new NotFoundError("No default role to provision an SSO user into");
      user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: (payload.name as string) || email,
          passwordHash: "sso-only-no-local-password", // never matches bcrypt.compare - local /auth/login stays impossible for this account
          roles: { create: [{ roleId: viewerRole.id }] },
        },
      });
    }

    const authUser = await loadAuthUser(user.id);
    const sessionToken = signTenantToken(authUser);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auditService.record({ tenantId: tenant.id, actorId: user.id, action: "auth.sso_login", entityType: "User", entityId: user.id, ipAddress: input.ipAddress });

    return { token: sessionToken, user: authUser };
  },
};
