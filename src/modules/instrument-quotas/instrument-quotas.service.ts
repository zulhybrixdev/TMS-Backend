import { PaymentMethod } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { ConflictError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { toDateOnly, todayDateOnly, isoDate } from "../../common/dates";

const COMMITTED = ["DRAFT", "PENDING_APPROVAL", "APPROVED"] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

const include = { bank: true };

function serialize(row: any) {
  return {
    id: row.id,
    paymentMethod: row.paymentMethod as PaymentMethod,
    bankId: row.bankId,
    bankName: row.bank?.name ?? null,
    dailyAmountLimit: row.dailyAmountLimit == null ? null : Number(row.dailyAmountLimit),
    dailyCountLimit: row.dailyCountLimit,
    currencyCode: row.currencyCode,
    isActive: row.isActive,
  };
}

interface PaymentSlice {
  id: string;
  amount: number;
  currencyCode: string;
  status: string;
  paymentMethod: PaymentMethod;
  bankId: string;
}

function applies(quota: { paymentMethod: PaymentMethod; bankId: string | null }, p: PaymentSlice) {
  return p.paymentMethod === quota.paymentMethod && (quota.bankId === null || quota.bankId === p.bankId);
}

function tally(quota: { currencyCode: string }, payments: PaymentSlice[]) {
  let releasedAmount = 0, releasedCount = 0, pendingAmount = 0, pendingCount = 0;
  for (const p of payments) {
    // The amount ceiling is in the quota's own currency; the count ceiling is currency-blind.
    const amount = p.currencyCode === quota.currencyCode ? p.amount : 0;
    if (p.status === "PROCESSED") {
      releasedAmount += amount;
      releasedCount += 1;
    } else {
      pendingAmount += amount;
      pendingCount += 1;
    }
  }
  return { releasedAmount: round2(releasedAmount), releasedCount, pendingAmount: round2(pendingAmount), pendingCount };
}

async function loadPayments(tenantId: string, date: Date, excludePaymentId?: string): Promise<PaymentSlice[]> {
  const rows = await prisma.payment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      paymentDate: date,
      paymentMethod: { in: ["CHEQUE", "BANK_DRAFT"] },
      status: { in: ["PROCESSED", ...COMMITTED] },
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
    select: { id: true, amount: true, currencyCode: true, status: true, paymentMethod: true, sourceAccount: { select: { bankId: true } } },
  });
  return rows.map((r) => ({ id: r.id, amount: Number(r.amount), currencyCode: r.currencyCode, status: r.status, paymentMethod: r.paymentMethod, bankId: r.sourceAccount.bankId }));
}

// Treasury Service: cheque / bank draft released quota. A quota is a per-day
// ceiling (amount and/or count) on what can be released by that instrument,
// for one bank or all banks combined (e.g. "MBSB bank draft"). "Released"
// is payments already approved and posted for that day; "pending" is
// payments still in the pipeline for that day (draft / awaiting approval /
// approved but not yet due) - both are shown because a quota is really
// about what's left to commit.
export const instrumentQuotasService = {
  async list(tenantId: string) {
    const rows = await prisma.instrumentQuota.findMany({ where: { tenantId }, include, orderBy: [{ paymentMethod: "asc" }, { createdAt: "asc" }] });
    return rows.map(serialize);
  },

  async create(tenantId: string, input: any, actorId: string) {
    await this.assertUnique(tenantId, input.paymentMethod, input.bankId ?? null);
    if (input.bankId) {
      const bank = await prisma.bank.findFirst({ where: { id: input.bankId, tenantId, deletedAt: null } });
      if (!bank) throw new NotFoundError("Bank not found");
    }
    const row = await prisma.instrumentQuota.create({ data: { ...input, bankId: input.bankId ?? null, tenantId }, include });
    await auditService.record({ tenantId, actorId, action: "quota.create", entityType: "InstrumentQuota", entityId: row.id, afterState: serialize(row) });
    return serialize(row);
  },

  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.instrumentQuota.findFirst({ where: { id, tenantId }, include });
    if (!before) throw new NotFoundError("Quota not found");
    const method = input.paymentMethod ?? before.paymentMethod;
    const bankId = input.bankId === undefined ? before.bankId : input.bankId;
    if (method !== before.paymentMethod || bankId !== before.bankId) await this.assertUnique(tenantId, method, bankId, id);
    const row = await prisma.instrumentQuota.update({ where: { id }, data: input, include });
    await auditService.record({ tenantId, actorId, action: "quota.update", entityType: "InstrumentQuota", entityId: id, beforeState: serialize(before), afterState: serialize(row) });
    return serialize(row);
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const before = await prisma.instrumentQuota.findFirst({ where: { id, tenantId }, include });
    if (!before) throw new NotFoundError("Quota not found");
    await prisma.instrumentQuota.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "quota.delete", entityType: "InstrumentQuota", entityId: id, beforeState: serialize(before) });
    return { deleted: true };
  },

  async assertUnique(tenantId: string, paymentMethod: PaymentMethod, bankId: string | null, excludeId?: string) {
    const dup = await prisma.instrumentQuota.findFirst({ where: { tenantId, paymentMethod, bankId, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (dup) throw new ConflictError("A quota for this instrument and bank already exists - edit it instead");
  },

  async usage(tenantId: string, date: Date = todayDateOnly()) {
    const [quotas, payments] = await Promise.all([
      prisma.instrumentQuota.findMany({ where: { tenantId, isActive: true }, include, orderBy: [{ paymentMethod: "asc" }, { createdAt: "asc" }] }),
      loadPayments(tenantId, toDateOnly(date)),
    ]);

    return quotas.map((q) => {
      const t = tally(q, payments.filter((p) => applies(q, p)));
      const limitAmount = q.dailyAmountLimit == null ? null : Number(q.dailyAmountLimit);
      const remainingAmount = limitAmount == null ? null : round2(limitAmount - t.releasedAmount - t.pendingAmount);
      const remainingCount = q.dailyCountLimit == null ? null : q.dailyCountLimit - t.releasedCount - t.pendingCount;
      const utilisation = limitAmount ? (t.releasedAmount + t.pendingAmount) / limitAmount : q.dailyCountLimit ? (t.releasedCount + t.pendingCount) / q.dailyCountLimit : 0;
      return {
        ...serialize(q),
        date: isoDate(toDateOnly(date)),
        ...t,
        remainingAmount,
        remainingCount,
        utilisationPct: Math.round(utilisation * 100),
        exceeded: (remainingAmount !== null && remainingAmount < 0) || (remainingCount !== null && remainingCount < 0),
      };
    });
  },

  // Advisory only (the brief says "display", not "block"): returns a
  // human-readable warning if releasing this payment would take any
  // applicable quota over its limit, or null if it fits / no quota applies.
  async checkPayment(
    tenantId: string,
    payment: { id?: string; paymentMethod: PaymentMethod; paymentDate: Date; amount: number; currencyCode: string; sourceAccountId: string }
  ): Promise<string | null> {
    if (payment.paymentMethod === "TRANSFER") return null;
    const account = await prisma.bankAccount.findFirst({ where: { id: payment.sourceAccountId, tenantId }, select: { bankId: true, bank: { select: { name: true } } } });
    if (!account) return null;

    const [quotas, others] = await Promise.all([
      prisma.instrumentQuota.findMany({ where: { tenantId, isActive: true, paymentMethod: payment.paymentMethod }, include }),
      loadPayments(tenantId, toDateOnly(payment.paymentDate), payment.id),
    ]);

    const me: PaymentSlice = { id: payment.id ?? "new", amount: payment.amount, currencyCode: payment.currencyCode, status: "DRAFT", paymentMethod: payment.paymentMethod, bankId: account.bankId };
    const label = payment.paymentMethod === "CHEQUE" ? "cheque" : "bank draft";

    for (const q of quotas) {
      if (!applies(q, me)) continue;
      const t = tally(q, others.filter((p) => applies(q, p)));
      const scope = q.bank?.name ? `${q.bank.name} ` : "";
      if (q.dailyAmountLimit != null && me.currencyCode === q.currencyCode) {
        const used = t.releasedAmount + t.pendingAmount + me.amount;
        if (used > Number(q.dailyAmountLimit)) {
          return `This would take the ${scope}${label} quota for ${isoDate(payment.paymentDate)} to ${used.toLocaleString()} ${q.currencyCode}, over its ${Number(q.dailyAmountLimit).toLocaleString()} ${q.currencyCode} daily limit.`;
        }
      }
      if (q.dailyCountLimit != null && t.releasedCount + t.pendingCount + 1 > q.dailyCountLimit) {
        return `This would exceed the ${scope}${label} quota of ${q.dailyCountLimit} per day for ${isoDate(payment.paymentDate)}.`;
      }
    }
    return null;
  },
};
