import { prisma } from "../../common/prisma";
import { auditService } from "../../common/audit.service";
import { BadRequestError } from "../../common/errors";

// Administration -> Security: org-wide "require two-factor authentication".
// Available on every plan (a security baseline shouldn't be paywalled), but
// meaningless for a single-user (INDIVIDUAL) tenant, which can simply turn
// MFA on for themselves - hence hidden there in the UI and rejected here.
export const securityPolicyService = {
  async get(tenantId: string) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { mfaRequired: true } });
    const [totalUsers, usersWithMfa] = await Promise.all([
      prisma.user.count({ where: { tenantId, deletedAt: null, status: "ACTIVE" } }),
      prisma.user.count({ where: { tenantId, deletedAt: null, status: "ACTIVE", totpEnabled: true } }),
    ]);
    return { mfaRequired: tenant.mfaRequired, totalUsers, usersWithMfa };
  },

  async setMfaRequired(tenantId: string, mfaRequired: boolean, actorId: string) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (tenant.accountType === "INDIVIDUAL") {
      throw new BadRequestError("Individual accounts have a single user - just turn on two-factor authentication from My Account");
    }
    await prisma.tenant.update({ where: { id: tenantId }, data: { mfaRequired } });
    await auditService.record({
      tenantId,
      actorId,
      action: mfaRequired ? "security.mfa_required_on" : "security.mfa_required_off",
      entityType: "Tenant",
      entityId: tenantId,
      beforeState: { mfaRequired: tenant.mfaRequired },
      afterState: { mfaRequired },
    });
    return this.get(tenantId);
  },
};
