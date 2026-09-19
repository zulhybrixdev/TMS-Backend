import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { PLAN_CATALOG, PlanKeyValue } from "../../common/plans";
import { buildCheckoutUrl, isFiuuConfigured } from "./fiuu-client";

const BILLING_PERIOD_DAYS = 30;

function generateOrderId(tenantId: string): string {
  return `SUB-${tenantId.slice(-8)}-${Date.now().toString(36).toUpperCase()}`;
}

export const billingService = {
  // Creates a pending invoice + a Fiuu (or dummy) checkout URL for
  // upgrading/starting a paid plan. Shared by registration and the
  // Settings > Subscription "change plan" flow.
  async createCheckout(input: { tenantId: string; subscriptionId: string; planKey: PlanKeyValue; billName: string; billEmail: string }) {
    const plan = PLAN_CATALOG[input.planKey];
    const orderId = generateOrderId(input.tenantId);

    const invoice = await prisma.subscriptionInvoice.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        planKey: input.planKey,
        amountMYR: plan.priceMYR,
        status: "PENDING",
        gateway: "fiuu",
        gatewayOrderId: orderId,
      },
    });

    const checkout = buildCheckoutUrl({
      orderId,
      amountMYR: plan.priceMYR,
      description: `${plan.name} plan subscription`,
      billName: input.billName,
      billEmail: input.billEmail,
    });

    return { invoice, checkoutUrl: checkout.url, isDummy: checkout.isDummy };
  },

  // Called from the (real or dummy) gateway notification/return handler
  // once the signature has already been verified by the caller.
  async handleGatewayResult(input: { orderId: string; tranId: string; success: boolean; rawPayload: unknown }) {
    const invoice = await prisma.subscriptionInvoice.findUnique({ where: { gatewayOrderId: input.orderId } });
    if (!invoice) throw new NotFoundError("Invoice not found for this order");
    if (invoice.status !== "PENDING") return invoice; // already processed - notifications can arrive more than once

    if (!input.success) {
      const failed = await prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: { status: "FAILED", gatewayTranId: input.tranId, rawPayload: input.rawPayload as any },
      });
      await auditService.record({ tenantId: invoice.tenantId, action: "subscription.payment_failed", entityType: "SubscriptionInvoice", entityId: invoice.id });
      return failed;
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + BILLING_PERIOD_DAYS * 86400000);

    const [paidInvoice] = await prisma.$transaction([
      prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: { status: "PAID", paidAt: now, gatewayTranId: input.tranId, rawPayload: input.rawPayload as any },
      }),
      prisma.subscription.update({
        where: { id: invoice.subscriptionId },
        data: { planKey: invoice.planKey, status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false },
      }),
    ]);

    await auditService.record({
      tenantId: invoice.tenantId,
      action: "subscription.activated",
      entityType: "Subscription",
      entityId: invoice.subscriptionId,
      afterState: { planKey: invoice.planKey },
    });

    return paidInvoice;
  },

  isDummyMode() {
    return !isFiuuConfigured();
  },
};
