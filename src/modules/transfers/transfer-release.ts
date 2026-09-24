import { Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { BadRequestError } from "../../common/errors";
import { postLedgerEntry } from "../../treasury-engine/ledger.service";
import { validateTransferAmount } from "../../treasury-engine/cash-engine.service";
import { todayDateOnly } from "../../common/dates";
import { floatService } from "../treasury-desk/float.service";
import { notificationsService } from "../notifications/notifications.service";

type TxClient = Prisma.TransactionClient;

// Same rule as payments (see payments/payment-release.ts): funds move on the
// transfer date. An approved transfer dated today or earlier is posted at
// once; a future-dated one stays APPROVED until the release sweep reaches it.
export function isTransferDue(transferDate: Date): boolean {
  return transferDate <= todayDateOnly();
}

// Re-validates against the *current* balance (it may have moved since the
// request was made), then posts both legs and completes the transfer.
export async function postTransferToLedger(tx: TxClient, tenantId: string, transferId: string) {
  const transfer = await tx.transfer.findUniqueOrThrow({ where: { id: transferId } });
  const source = await tx.bankAccount.findUniqueOrThrow({ where: { id: transfer.sourceAccountId } });
  const float = await floatService.forAccount(tenantId, source.id, tx);

  const check = validateTransferAmount(
    {
      currentBalance: Number(source.currentBalance),
      reservedAmount: Number(source.reservedAmount),
      minimumBalance: Number(source.minimumBalance),
      overdraftLimit: Number(source.overdraftLimit),
      floatAmount: float.total,
    },
    Number(transfer.amount)
  );
  if (!check.valid) throw new BadRequestError(`Cannot execute transfer: ${check.reason}`);

  await postLedgerEntry(tx, {
    tenantId,
    accountId: transfer.sourceAccountId,
    currencyCode: transfer.currencyCode,
    type: "TRANSFER_OUT",
    amount: Number(transfer.amount),
    reference: transfer.transferNumber,
    description: transfer.reason ?? "Inter-bank transfer",
    relatedTransferId: transfer.id,
  });
  await postLedgerEntry(tx, {
    tenantId,
    accountId: transfer.destinationAccountId,
    currencyCode: transfer.currencyCode,
    type: "TRANSFER_IN",
    amount: Number(transfer.amount),
    reference: transfer.transferNumber,
    description: transfer.reason ?? "Inter-bank transfer",
    relatedTransferId: transfer.id,
  });
  await tx.transfer.update({ where: { id: transfer.id }, data: { status: "COMPLETED" } });
}

export async function releaseApprovedTransfer(transferId: string): Promise<boolean> {
  const released = await prisma.$transaction(async (tx) => {
    const transfer = await tx.transfer.findFirst({ where: { id: transferId, status: "APPROVED" } });
    if (!transfer || !isTransferDue(transfer.transferDate)) return null;
    await postTransferToLedger(tx, transfer.tenantId, transfer.id);
    return transfer;
  });
  if (released) {
    await notificationsService.notify({
      tenantId: released.tenantId,
      userId: released.requestedById,
      title: "Transfer released",
      message: `${released.transferNumber} reached its transfer date and has been posted.`,
      type: "INFO",
      relatedEntityType: "TRANSFER",
      relatedEntityId: released.id,
    });
  }
  return !!released;
}

export async function releaseDueApprovedTransfers(): Promise<{ released: number; attempted: number }> {
  const due = await prisma.transfer.findMany({ where: { status: "APPROVED", transferDate: { lte: todayDateOnly() } }, select: { id: true } });
  let released = 0;
  for (const { id } of due) {
    try {
      if (await releaseApprovedTransfer(id)) released += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[transfers] scheduled release failed for transfer ${id}:`, err);
    }
  }
  return { released, attempted: due.length };
}
