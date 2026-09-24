import { Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { postLedgerEntry } from "../../treasury-engine/ledger.service";
import { todayDateOnly } from "../../common/dates";
import { notificationsService } from "../notifications/notifications.service";

type TxClient = Prisma.TransactionClient;

// A payment's cash leaves the account on its due date (paymentDate), not the
// moment it is approved: the forecast debits it on that day, and until then
// it stays APPROVED - visible, reschedulable, cancellable. Approving a
// payment that is already due (or overdue) posts it immediately, exactly as
// before; a future-dated one is picked up by the sweep below on its day.
export function isDueForRelease(paymentDate: Date): boolean {
  return paymentDate <= todayDateOnly();
}

export async function postPaymentToLedger(
  tx: TxClient,
  tenantId: string,
  payment: { id: string; sourceAccountId: string; currencyCode: string; amount: unknown; paymentNumber: string; beneficiaryName: string; description: string | null }
) {
  await postLedgerEntry(tx, {
    tenantId,
    accountId: payment.sourceAccountId,
    currencyCode: payment.currencyCode,
    type: "PAYMENT_OUT",
    amount: Number(payment.amount),
    reference: payment.paymentNumber,
    description: `Payment to ${payment.beneficiaryName}: ${payment.description ?? ""}`,
    relatedPaymentId: payment.id,
  });
  await tx.payment.update({ where: { id: payment.id }, data: { status: "PROCESSED" } });
}

// Posts one APPROVED payment if (and only if) it is still APPROVED and due -
// re-checked inside the transaction so a payment cancelled or rescheduled
// between the sweep's read and this write is left alone.
export async function releaseApprovedPayment(paymentId: string): Promise<boolean> {
  const released = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, status: "APPROVED", deletedAt: null } });
    if (!payment || !isDueForRelease(payment.paymentDate)) return null;
    await postPaymentToLedger(tx, payment.tenantId, payment);
    return payment;
  });
  if (released) {
    await notificationsService.notify({
      tenantId: released.tenantId,
      userId: released.requestedById,
      title: "Payment released",
      message: `${released.paymentNumber} to ${released.beneficiaryName} reached its due date and has been posted.`,
      type: "INFO",
      relatedEntityType: "PAYMENT",
      relatedEntityId: released.id,
    });
  }
  return !!released;
}

// Periodic sweep (index.ts), global across tenants like the SLA and
// recurring-template sweeps - and with the same single-instance caveat.
export async function releaseDueApprovedPayments(): Promise<{ released: number; attempted: number }> {
  const due = await prisma.payment.findMany({ where: { status: "APPROVED", deletedAt: null, paymentDate: { lte: todayDateOnly() } }, select: { id: true } });
  let released = 0;
  for (const { id } of due) {
    try {
      if (await releaseApprovedPayment(id)) released += 1;
    } catch (err) {
      // One bad payment must not stop the rest; it is retried on the next sweep.
      // eslint-disable-next-line no-console
      console.error(`[payments] scheduled release failed for payment ${id}:`, err);
    }
  }
  return { released, attempted: due.length };
}
