import { PaymentTemplateFrequency } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { notificationsService } from "../notifications/notifications.service";
import { paymentsService } from "../payments/payments.service";

interface TemplateInput {
  name: string;
  beneficiaryName: string;
  beneficiaryAccount: string;
  beneficiaryBank: string;
  amount: number;
  currencyCode: string;
  sourceAccountId: string;
  description?: string;
  reference?: string;
  frequency?: PaymentTemplateFrequency;
  nextRunDate?: string;
  isActive?: boolean;
}

// WEEKLY/MONTHLY only (see schema) - calendar-month add, not "+30 days",
// so a template dated the 1st stays on the 1st every month rather than
// drifting later each cycle.
function advanceNextRun(from: Date, frequency: PaymentTemplateFrequency): Date {
  const next = new Date(from);
  if (frequency === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  else if (frequency === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function serialize(template: any) {
  return { ...template, amount: Number(template.amount) };
}

export const paymentTemplatesService = {
  async list(tenantId: string) {
    const rows = await prisma.paymentTemplate.findMany({
      where: { tenantId },
      include: { sourceAccount: { include: { bank: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map(serialize);
  },

  async getById(tenantId: string, id: string) {
    const template = await prisma.paymentTemplate.findFirst({ where: { id, tenantId }, include: { sourceAccount: { include: { bank: true } } } });
    if (!template) throw new NotFoundError("Payment template not found");
    return serialize(template);
  },

  async create(tenantId: string, input: TemplateInput, actorId: string) {
    const { nextRunDate, ...rest } = input;
    // A recurring template needs a nextRunDate to ever fire - default to
    // today (fires on the next sweep) if the caller set a frequency but no
    // explicit start date.
    const resolvedNextRunDate = rest.frequency && rest.frequency !== "NONE" ? new Date(nextRunDate ?? new Date().toISOString().slice(0, 10)) : nextRunDate ? new Date(nextRunDate) : undefined;
    const template = await prisma.paymentTemplate.create({ data: { ...rest, nextRunDate: resolvedNextRunDate, tenantId, createdById: actorId } });
    await auditService.record({ tenantId, actorId, action: "payment_template.create", entityType: "PaymentTemplate", entityId: template.id, afterState: serialize(template) });
    return serialize(template);
  },

  async update(tenantId: string, id: string, input: Partial<TemplateInput>, actorId: string) {
    const before = await prisma.paymentTemplate.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Payment template not found");
    const { nextRunDate, ...rest } = input;
    const template = await prisma.paymentTemplate.update({ where: { id }, data: { ...rest, ...(nextRunDate ? { nextRunDate: new Date(nextRunDate) } : {}) } });
    await auditService.record({ tenantId, actorId, action: "payment_template.update", entityType: "PaymentTemplate", entityId: id, beforeState: before, afterState: serialize(template) });
    return serialize(template);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const before = await prisma.paymentTemplate.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Payment template not found");
    await prisma.paymentTemplate.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "payment_template.delete", entityType: "PaymentTemplate", entityId: id, beforeState: before });
    return { deleted: true };
  },

  // One-click reuse: creates a normal DRAFT Payment from the template's
  // saved fields, same as if the Maker had typed them in by hand - so it
  // still goes through the regular submit/approve flow, not a shortcut
  // around it. `overrides` lets the amount/date differ per use (e.g. this
  // month's rent is slightly different, or paying on a different date).
  async useTemplate(tenantId: string, id: string, actorId: string, overrides: { amount?: number; paymentDate?: string } = {}) {
    const template = await prisma.paymentTemplate.findFirst({ where: { id, tenantId } });
    if (!template) throw new NotFoundError("Payment template not found");

    const payment = await paymentsService.create(
      tenantId,
      {
        beneficiaryName: template.beneficiaryName,
        beneficiaryAccount: template.beneficiaryAccount,
        beneficiaryBank: template.beneficiaryBank,
        amount: overrides.amount ?? Number(template.amount),
        currencyCode: template.currencyCode,
        sourceAccountId: template.sourceAccountId,
        paymentDate: overrides.paymentDate ?? new Date().toISOString().slice(0, 10),
        description: template.description ?? undefined,
        reference: template.reference ?? undefined,
      },
      actorId
    );

    await auditService.record({
      tenantId,
      actorId,
      action: "payment_template.use",
      entityType: "PaymentTemplate",
      entityId: id,
      afterState: { createdPaymentId: payment.id },
    });
    return payment;
  },

  // Recurring auto-generation sweep (see index.ts's setInterval, same
  // pattern as approvalsService.checkEscalations). Finds every active
  // template across every tenant whose nextRunDate has arrived, creates a
  // DRAFT payment from it via the exact same useTemplate() path a manual
  // click would take (still goes through submit/approve, no shortcut), and
  // advances nextRunDate to the following cycle. One late/failed run never
  // blocks the next: nextRunDate always advances from itself, not from
  // "now", so a template stays on its original schedule (1st of the month
  // stays the 1st) even if a run was a day late.
  async runScheduledTemplates() {
    const due = await prisma.paymentTemplate.findMany({
      where: { isActive: true, frequency: { not: "NONE" }, nextRunDate: { lte: new Date() } },
    });

    let created = 0;
    for (const template of due) {
      try {
        const payment = await this.useTemplate(template.tenantId, template.id, template.createdById, {});
        const next = advanceNextRun(template.nextRunDate!, template.frequency);
        await prisma.paymentTemplate.update({ where: { id: template.id }, data: { nextRunDate: next, lastRunAt: new Date() } });
        await notificationsService.notify({
          tenantId: template.tenantId,
          userId: template.createdById,
          title: "Recurring payment created",
          message: `"${template.name}" auto-created a new draft payment (${payment.paymentNumber}) - review and submit it for approval.`,
          type: "INFO",
          relatedEntityType: "Payment",
          relatedEntityId: payment.id,
        });
        created += 1;
      } catch (err) {
        // A bad template (e.g. its source account was since closed)
        // shouldn't stop the rest of the sweep - log and move on, it'll be
        // retried on the next sweep since nextRunDate only advances on success.
        // eslint-disable-next-line no-console
        console.error(`[payment-templates] scheduled run failed for template ${template.id}:`, err);
      }
    }
    return { created, attempted: due.length };
  },
};
