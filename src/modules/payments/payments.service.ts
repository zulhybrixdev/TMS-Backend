import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { generateDocumentNumber } from "../../common/id-generator";
import { approvalsService } from "../approvals/approvals.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";
import { createPaymentSchema } from "./payments.schemas";
import { detectPaymentAnomaly, NO_ACCOUNT } from "./anomaly-detection";
import { instrumentQuotasService } from "../instrument-quotas/instrument-quotas.service";
import { isDueForRelease, releaseApprovedPayment } from "./payment-release";
import { toDateOnly } from "../../common/dates";

const paymentInclude = {
  sourceAccount: { include: { bank: true } },
  currency: true,
  requestedBy: { select: { id: true, name: true, email: true } },
  approvalRequests: { include: { actions: { include: { actor: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "desc" as const } },
};

function serialize(payment: any) {
  return {
    id: payment.id,
    paymentNumber: payment.paymentNumber,
    beneficiaryName: payment.beneficiaryName,
    beneficiaryAccount: payment.beneficiaryAccount,
    beneficiaryBank: payment.beneficiaryBank,
    amount: Number(payment.amount),
    currencyCode: payment.currencyCode,
    sourceAccountId: payment.sourceAccountId,
    sourceAccountName: payment.sourceAccount?.accountName,
    sourceBankName: payment.sourceAccount?.bank?.name,
    paymentDate: payment.paymentDate,
    paymentMethod: payment.paymentMethod,
    invoiceNumber: payment.invoiceNumber,
    description: payment.description,
    reference: payment.reference,
    attachmentUrl: payment.attachmentUrl,
    status: payment.status,
    requestedBy: payment.requestedBy,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    approvalRequests: payment.approvalRequests,
  };
}

// A payment is paid out of one account in one currency - the ledger posts the
// payment's amount straight onto the account's balance, so a USD invoice
// must come out of a USD account (paying it from MYR would deduct the USD
// figure from a MYR balance).
function assertCurrencyMatchesAccount(account: { currencyCode: string; accountName: string }, currencyCode: string) {
  if (account.currencyCode !== currencyCode) {
    throw new BadRequestError(`Payment currency (${currencyCode}) must match the source account's currency (${account.currencyCode} - ${account.accountName}). Pick a ${currencyCode} account.`);
  }
}

// Advisory cheque / bank draft quota warning, surfaced next to the payment
// (never blocks it - the brief asks for the quota to be displayed).
async function quotaWarningFor(tenantId: string, payment: any): Promise<string | null> {
  return instrumentQuotasService.checkPayment(tenantId, {
    id: payment.id,
    paymentMethod: payment.paymentMethod,
    paymentDate: payment.paymentDate,
    amount: Number(payment.amount),
    currencyCode: payment.currencyCode,
    sourceAccountId: payment.sourceAccountId,
  });
}

export const paymentsService = {
  async list(tenantId: string, query: ParsedListQuery, filters: { status?: string; sourceAccountId?: string; paymentMethod?: string; from?: string; to?: string }, scope?: { userId: string; canViewAll: boolean }) {
    const where: any = { tenantId, deletedAt: null };
    if (filters.status) where.status = filters.status;
    if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod;
    if (filters.sourceAccountId) where.sourceAccountId = filters.sourceAccountId;
    if (filters.from || filters.to) {
      where.paymentDate = {};
      if (filters.from) where.paymentDate.gte = new Date(filters.from);
      if (filters.to) where.paymentDate.lte = new Date(filters.to);
    }
    if (query.search) {
      where.OR = [
        { paymentNumber: { contains: query.search } },
        { beneficiaryName: { contains: query.search } },
        { reference: { contains: query.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.payment.findMany({ where, include: paymentInclude, skip: query.skip, take: query.take, orderBy: { [query.sortBy ?? "createdAt"]: query.sortDir } }),
      prisma.payment.count({ where }),
    ]);

    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async getById(tenantId: string, id: string) {
    const payment = await prisma.payment.findFirst({ where: { id, tenantId, deletedAt: null }, include: paymentInclude });
    if (!payment) throw new NotFoundError("Payment not found");
    const anomaly = await detectPaymentAnomaly(tenantId, payment.beneficiaryAccount, Number(payment.amount), payment.id, payment.beneficiaryName);
    const quotaWarning = ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(payment.status) ? await quotaWarningFor(tenantId, payment) : null;
    return { ...serialize(payment), anomaly, quotaWarning };
  },

  async create(tenantId: string, input: any, actorId: string) {
    const account = await prisma.bankAccount.findFirst({ where: { id: input.sourceAccountId, tenantId, deletedAt: null } });
    if (!account) throw new NotFoundError("Source account not found");
    assertCurrencyMatchesAccount(account, input.currencyCode);

    const paymentNumber = await generateDocumentNumber(tenantId, "PMT");
    const payment = await prisma.payment.create({
      data: {
        ...input,
        beneficiaryAccount: input.beneficiaryAccount ?? NO_ACCOUNT,
        beneficiaryBank: input.beneficiaryBank ?? NO_ACCOUNT,
        paymentMethod: input.paymentMethod ?? "TRANSFER",
        tenantId,
        paymentNumber,
        paymentDate: toDateOnly(input.paymentDate),
        status: "DRAFT",
        requestedById: actorId,
      },
      include: paymentInclude,
    });

    await auditService.record({ tenantId, actorId, action: "payment.create", entityType: "Payment", entityId: payment.id, afterState: serialize(payment) });
    return { ...serialize(payment), quotaWarning: await quotaWarningFor(tenantId, payment) };
  },

  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.payment.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!before) throw new NotFoundError("Payment not found");
    if (before.status !== "DRAFT") throw new ConflictError("Only draft payments can be edited");

    const data = { ...input };
    if (data.paymentDate) data.paymentDate = toDateOnly(data.paymentDate);
    if (data.sourceAccountId || data.currencyCode) {
      const account = await prisma.bankAccount.findFirst({ where: { id: data.sourceAccountId ?? before.sourceAccountId, tenantId, deletedAt: null } });
      if (!account) throw new NotFoundError("Source account not found");
      assertCurrencyMatchesAccount(account, data.currencyCode ?? before.currencyCode);
    }
    const payment = await prisma.payment.update({ where: { id }, data, include: paymentInclude });
    await auditService.record({ tenantId, actorId, action: "payment.update", entityType: "Payment", entityId: id, beforeState: before, afterState: serialize(payment) });
    return { ...serialize(payment), quotaWarning: await quotaWarningFor(tenantId, payment) };
  },

  // Adjust the due date. Unlike update() (draft-only, edits any field), this
  // only moves the date and is allowed until the payment is actually posted,
  // so an AP that is already awaiting approval - or fully approved and
  // waiting for its day - can still be pushed out or pulled in. Every change
  // is audit-logged with who/when/from/to and an optional reason.
  async reschedule(tenantId: string, id: string, input: { paymentDate: string; reason?: string }, actorId: string) {
    const before = await prisma.payment.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!before) throw new NotFoundError("Payment not found");
    if (!["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(before.status)) {
      throw new ConflictError("Only payments that have not been posted yet can be rescheduled");
    }
    const paymentDate = toDateOnly(input.paymentDate);
    if (Number.isNaN(paymentDate.getTime())) throw new BadRequestError("Invalid date");

    await prisma.payment.update({ where: { id }, data: { paymentDate } });
    await auditService.record({
      tenantId,
      actorId,
      action: "payment.reschedule",
      entityType: "Payment",
      entityId: id,
      beforeState: { paymentDate: before.paymentDate },
      afterState: { paymentDate, reason: input.reason },
    });

    // Pulled in to today or earlier while already approved: nothing left to
    // wait for, so post it now rather than on the next sweep.
    if (before.status === "APPROVED" && isDueForRelease(paymentDate)) await releaseApprovedPayment(id);
    return this.getById(tenantId, id);
  },

  // Maker submits a DRAFT payment for approval; this opens the approval
  // workflow gate (see approvals.service) so a Checker/Manager must act
  // before funds actually leave the account.
  async submit(tenantId: string, id: string, actorId: string) {
    const payment = await prisma.$transaction(async (tx) => {
      const before = await tx.payment.findFirst({ where: { id, tenantId, deletedAt: null } });
      if (!before) throw new NotFoundError("Payment not found");
      if (before.status !== "DRAFT") throw new ConflictError("Only draft payments can be submitted for approval");

      const updated = await tx.payment.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
      await approvalsService.createForEntity(tx, {
        tenantId,
        entityType: "PAYMENT",
        paymentId: id,
        requestedById: actorId,
        amount: Number(updated.amount),
        currencyCode: updated.currencyCode,
      });
      return updated;
    });

    await auditService.record({ tenantId, actorId, action: "payment.submit", entityType: "Payment", entityId: id, afterState: { status: "PENDING_APPROVAL" } });

    const result = await this.getById(tenantId, payment.id);
    if (result.anomaly.flagged) {
      // Visible to whoever opens this payment (Maker, Checker, Manager) via
      // `anomaly` on the response, and logged for compliance/audit review -
      // deliberately not a separate notification on top of the normal
      // "approval required" one, to avoid alert fatigue for a statistical
      // heuristic rather than a confirmed fraud finding.
      await auditService.record({
        tenantId,
        actorId,
        action: "payment.anomaly_flagged",
        entityType: "Payment",
        entityId: id,
        afterState: { reason: result.anomaly.reason },
      });
    }
    return result;
  },

  // Bulk payment upload: each row goes through the exact same create() path
  // (and its own source-account check, document number, audit entry) as a
  // single payment - rows succeed/fail independently so one bad row (e.g. a
  // typo'd account) doesn't sink the whole batch.
  async bulkCreate(tenantId: string, rows: unknown[], actorId: string) {
    const created: ReturnType<typeof serialize>[] = [];
    const failed: { index: number; error: string }[] = [];

    for (let index = 0; index < rows.length; index++) {
      const parsed = createPaymentSchema.safeParse(rows[index]);
      if (!parsed.success) {
        failed.push({ index, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      try {
        created.push(await this.create(tenantId, parsed.data, actorId));
      } catch (err) {
        failed.push({ index, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    await auditService.record({
      tenantId,
      actorId,
      action: "payment.bulk_create",
      entityType: "Payment",
      afterState: { attempted: rows.length, created: created.length, failed: failed.length },
    });

    return { created, failed };
  },

  async cancel(tenantId: string, id: string, actorId: string) {
    const payment = await prisma.payment.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!payment) throw new NotFoundError("Payment not found");
    if (!["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(payment.status)) {
      throw new BadRequestError("Only draft, pending or approved-but-not-yet-released payments can be cancelled");
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id }, data: { status: "CANCELLED" } });
      await tx.approvalRequest.updateMany({ where: { paymentId: id, status: "PENDING" }, data: { status: "CANCELLED" } });
    });

    await auditService.record({ tenantId, actorId, action: "payment.cancel", entityType: "Payment", entityId: id });
    return this.getById(tenantId, id);
  },
};
