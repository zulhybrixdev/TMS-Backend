import { LEGAL_VERSIONS } from "../../common/legal";
import { platformConfigService } from "../../common/platform-config.service";
import bcrypt from "bcryptjs";
import { TenantAccountType } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { env } from "../../config/env";
import { AppError, BadRequestError, ConflictError, TenantSuspendedError, UnauthorizedError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { loadAuthUser, signTenantToken, signMfaChallengeToken, signMfaEnrollmentToken } from "../../common/auth-token";
import { MODULE_KEYS, PLAN_KEYS, PlanKeyValue, planIncludesModule } from "../../common/plans";
import { ROLE_NAMES } from "../../common/permissions";
import { generateUniqueTenantSlug, provisionTenant } from "../../common/tenant-provisioning";
import { billingService } from "../billing/billing.service";

export interface RegisterInput {
  acceptTerms: true;
  acceptPrivacy: true;
  termsVersion: string;
  privacyVersion: string;
  companyName: string;
  accountType: TenantAccountType;
  planKey: PlanKeyValue;
  name: string;
  email: string;
  password: string;
  jobTitle?: string;
}

export const authService = {
  async login(email: string, password: string, ipAddress?: string) {
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) throw new UnauthorizedError("Invalid email or password");
    if (user.status !== "ACTIVE") throw new UnauthorizedError("This account is not active");

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) throw new UnauthorizedError("Invalid email or password");

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, include: { ssoConfig: true, subscription: true } });
    if (tenant.status === "SUSPENDED") throw new TenantSuspendedError();

    // A tenant admin can flip "Require SSO" once Keycloak SSO is
    // configured (Administration -> Security tab) - this blocks local
    // password login for everyone except Admins, who keep it as a
    // break-glass path (e.g. Keycloak itself is down, or a new admin
    // hasn't been set up in the IdP yet). Checked before the MFA branch
    // below since SSO-required is a stronger requirement than MFA.
    // Only while the plan still includes SSO: a tenant that downgraded from
    // Pro+ can't use SSO any more (sso.service.ts refuses it too), so
    // honouring ssoRequired here would lock its non-Admins out entirely.
    const ssoActive = !!tenant.subscription && planIncludesModule(tenant.subscription.planKey as PlanKeyValue, MODULE_KEYS.SSO);
    if (tenant.ssoConfig?.ssoRequired && ssoActive) {
      const isAdmin = await prisma.userRole.findFirst({ where: { userId: user.id, role: { name: ROLE_NAMES.ADMIN } } });
      if (!isAdmin) {
        throw new UnauthorizedError("This organisation requires signing in via SSO - use the \"Sign in with company SSO\" option instead");
      }
    }

    // Opt-in TOTP MFA (see mfa.service.ts) - password alone isn't enough
    // for an account that has it enabled. Return a narrow challenge token
    // instead of a real session; the frontend prompts for a code and
    // completes the exchange via POST /auth/mfa/challenge.
    if (user.totpEnabled) {
      return { mfaRequired: true as const, challengeToken: signMfaChallengeToken(user.id) };
    }

    // Org-wide "require MFA" (Administration -> Security): a user who hasn't
    // set it up yet gets a narrow enrollment token instead of a session -
    // it only works against /auth/mfa/setup and /verify, and completing
    // /verify is what issues the real session. SSO logins never reach here.
    if (tenant.mfaRequired) {
      return { mfaEnrollmentRequired: true as const, enrollmentToken: signMfaEnrollmentToken(user.id) };
    }

    const authUser = await loadAuthUser(user.id);
    const token = signTenantToken(authUser);

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auditService.record({
      tenantId: authUser.tenantId,
      actorId: user.id,
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
      ipAddress,
    });

    return { mfaRequired: false as const, token, user: authUser };
  },

  // Self-service signup: creates a brand-new tenant (with its own role set),
  // the admin user, and a subscription for the chosen plan. Free activates
  // immediately; Pro/Pro+ come back with a checkoutUrl for the frontend to
  // redirect to (real Fiuu or the dummy simulator - see billing module).
  async register(input: RegisterInput, ipAddress?: string) {
    // Also enforced here (not only in the route middleware) so no other caller can bypass it.
    if (!(await platformConfigService.isRegistrationEnabled())) {
      throw new AppError(403, "REGISTRATION_CLOSED", "New registrations are currently closed. Please try again later, or contact your administrator.");
    }
    // The person must have accepted the *current* documents. A version
    // mismatch means the text changed after they loaded the form (or the
    // client is stale), so they have to read it again before accepting.
    if (input.termsVersion !== LEGAL_VERSIONS.terms || input.privacyVersion !== LEGAL_VERSIONS.privacy) {
      throw new ConflictError("The Terms and Conditions or Privacy Policy have been updated. Please reload the page and review them again before registering.");
    }

    const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingEmail) throw new ConflictError("A user with this email already exists");

    const slug = await generateUniqueTenantSlug(input.companyName);
    const passwordHash = await bcrypt.hash(input.password, env.bcryptSaltRounds);
    const acceptedAt = new Date();

    const { user, tenantId } = await prisma.$transaction(async (tx) => {
      const { tenant, roleIdByName, subscription } = await provisionTenant(tx, {
        slug,
        name: input.companyName,
        accountType: input.accountType,
        planKey: input.planKey,
      });

      const adminRoleId = roleIdByName.get(ROLE_NAMES.ADMIN)!;
      const createdUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.email,
          name: input.name,
          jobTitle: input.jobTitle,
          passwordHash,
          termsAccepted: true,
          termsAcceptedAt: acceptedAt,
          termsVersion: LEGAL_VERSIONS.terms,
          privacyAccepted: true,
          privacyAcceptedAt: acceptedAt,
          privacyVersion: LEGAL_VERSIONS.privacy,
          roles: { create: [{ roleId: adminRoleId }] },
        },
      });

      return { user: createdUser, tenantId: tenant.id, subscriptionId: subscription.id };
    });

    await auditService.record({ tenantId, actorId: user.id, action: "auth.register", entityType: "Tenant", entityId: tenantId, ipAddress, afterState: { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, acceptedAt } });

    const authUser = await loadAuthUser(user.id);
    const token = signTenantToken(authUser);

    let checkoutUrl: string | undefined;
    if (input.planKey !== PLAN_KEYS.FREE) {
      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId } });
      const checkout = await billingService.createCheckout({
        tenantId,
        subscriptionId: subscription.id,
        planKey: input.planKey,
        billName: input.name,
        billEmail: input.email,
      });
      checkoutUrl = checkout.checkoutUrl;
    }

    return { token, user: authUser, checkoutUrl };
  },

  async me(userId: string) {
    return loadAuthUser(userId);
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const validPassword = await bcrypt.compare(currentPassword, user.passwordHash);
    // 400, not 401: this request is already authenticated, and a 401 would
    // make the client think the session expired and sign the user out.
    if (!validPassword) throw new BadRequestError("Current password is incorrect");

    const passwordHash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await auditService.record({ tenantId: user.tenantId, actorId: userId, action: "auth.change_password", entityType: "User", entityId: userId });
    return { changed: true };
  },
};
