import { prisma } from "../../common/prisma";

export interface AnomalyResult {
  flagged: boolean;
  reason?: string;
}

const ESTABLISHED_MULTIPLIER = 3; // 3x this beneficiary's own average, once we have a track record for them
const FIRST_TIME_MULTIPLIER = 5; // 5x the tenant's typical payment size, for a beneficiary we've never paid before
const MIN_HISTORY_FOR_TENANT_BASELINE = 3;

// Lightweight statistical check, not a real fraud model: flags a payment as
// worth a second look before it's approved, based only on this tenant's own
// history (no cross-tenant learning - that would leak one tenant's payment
// patterns into another's risk signal). Two rules:
//   1. Established beneficiary: amount is a large multiple of what we've
//      historically paid *this* beneficiary.
//   2. Never-paid-before beneficiary: amount is a large multiple of what
//      this tenant typically pays *anyone*, since there's no per-beneficiary
//      baseline yet to compare against.
export async function detectPaymentAnomaly(tenantId: string, beneficiaryAccount: string, amount: number, excludePaymentId?: string): Promise<AnomalyResult> {
  const priorToThisBeneficiary = await prisma.payment.findMany({
    where: {
      tenantId,
      beneficiaryAccount,
      deletedAt: null,
      status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] },
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
    select: { amount: true },
  });

  if (priorToThisBeneficiary.length > 0) {
    const avg = priorToThisBeneficiary.reduce((sum, p) => sum + Number(p.amount), 0) / priorToThisBeneficiary.length;
    if (avg > 0 && amount > avg * ESTABLISHED_MULTIPLIER) {
      return {
        flagged: true,
        reason: `${(amount / avg).toFixed(1)}x this beneficiary's usual payment amount (avg ${avg.toLocaleString(undefined, { maximumFractionDigits: 0 })} across ${priorToThisBeneficiary.length} prior payment${priorToThisBeneficiary.length > 1 ? "s" : ""})`,
      };
    }
    return { flagged: false };
  }

  // Never paid this beneficiary before - compare against the tenant's
  // overall typical payment size instead, but only once there's enough
  // history to make that baseline meaningful.
  const recentTenantPayments = await prisma.payment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { notIn: ["DRAFT", "REJECTED", "CANCELLED"] },
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
    select: { amount: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (recentTenantPayments.length < MIN_HISTORY_FOR_TENANT_BASELINE) return { flagged: false };

  const tenantAvg = recentTenantPayments.reduce((sum, p) => sum + Number(p.amount), 0) / recentTenantPayments.length;
  if (tenantAvg > 0 && amount > tenantAvg * FIRST_TIME_MULTIPLIER) {
    return {
      flagged: true,
      reason: `First payment to this beneficiary, and ${(amount / tenantAvg).toFixed(1)}x your typical payment size (avg ${tenantAvg.toLocaleString(undefined, { maximumFractionDigits: 0 })})`,
    };
  }
  return { flagged: false };
}
