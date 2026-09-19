import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { PLAN_CATALOG, PLAN_KEYS, PlanKeyValue } from "../../common/plans";
import { billingService } from "../billing/billing.service";

function serializeSubscription(subscription: { planKey: PlanKeyValue; status: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean }) {
  return {
    planKey: subscription.planKey,
    plan: PLAN_CATALOG[subscription.planKey],
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  };
}

export const subscriptionsService = {
  async getMe(tenantId: string) {
    const [tenant, subscription, userCount, bankAccountCount, invoices] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      prisma.subscription.findUnique({ where: { tenantId } }),
      prisma.user.count({ where: { tenantId, deletedAt: null } }),
      prisma.bankAccount.count({ where: { tenantId, deletedAt: null } }),
      prisma.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);

    const planKey = (subscription?.planKey ?? PLAN_KEYS.FREE) as PlanKeyValue;
    const plan = PLAN_CATALOG[planKey];

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, accountType: tenant.accountType },
      subscription: subscription ? serializeSubscription(subscription) : serializeSubscription({ planKey: PLAN_KEYS.FREE, status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }),
      plans: Object.values(PLAN_CATALOG),
      usage: {
        users: { current: userCount, limit: plan.limits.users },
        bankAccounts: { current: bankAccountCount, limit: plan.limits.bankAccounts },
      },
      invoices,
    };
  },

  // Downgrades (or lateral moves to a plan of equal/lower price) apply
  // immediately, blocked only if current usage would no longer fit. Any
  // move to a higher-priced plan requires a Fiuu (or dummy) checkout - the
  // plan only actually changes once billing.service.handleGatewayResult
  // confirms payment.
  async changePlan(tenantId: string, targetPlanKey: PlanKeyValue, actor: { id: string; name: string; email: string }) {
    const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
    if (!subscription) throw new NotFoundError("Subscription not found");

    const currentPlan = PLAN_CATALOG[subscription.planKey as PlanKeyValue];
    const targetPlan = PLAN_CATALOG[targetPlanKey];
    if (currentPlan.key === targetPlan.key) {
      throw new ConflictError(`Already on the ${targetPlan.name} plan`);
    }

    if (targetPlan.priceMYR <= currentPlan.priceMYR) {
      const [userCount, bankAccountCount] = await Promise.all([
        prisma.user.count({ where: { tenantId, deletedAt: null } }),
        prisma.bankAccount.count({ where: { tenantId, deletedAt: null } }),
      ]);
      if (targetPlan.limits.users !== null && userCount > targetPlan.limits.users) {
        throw new ConflictError(`You have ${userCount} users, which exceeds the ${targetPlan.name} plan's limit of ${targetPlan.limits.users}. Deactivate users before downgrading.`);
      }
      if (targetPlan.limits.bankAccounts !== null && bankAccountCount > targetPlan.limits.bankAccounts) {
        throw new ConflictError(`You have ${bankAccountCount} bank accounts, which exceeds the ${targetPlan.name} plan's limit of ${targetPlan.limits.bankAccounts}. Close accounts before downgrading.`);
      }

      const updated = await prisma.subscription.update({
        where: { tenantId },
        data: { planKey: targetPlanKey, status: "ACTIVE" },
      });
      await auditService.record({ tenantId, actorId: actor.id, action: "subscription.change", entityType: "Subscription", entityId: updated.id, beforeState: { planKey: currentPlan.key }, afterState: { planKey: targetPlanKey } });
      return { immediate: true as const, subscription: serializeSubscription(updated) };
    }

    const { checkoutUrl, isDummy } = await billingService.createCheckout({
      tenantId,
      subscriptionId: subscription.id,
      planKey: targetPlanKey,
      billName: actor.name,
      billEmail: actor.email,
    });
    return { immediate: false as const, checkoutUrl, isDummy };
  },
};
