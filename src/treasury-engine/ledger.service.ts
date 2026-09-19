import { Prisma, TransactionType } from "@prisma/client";

// Treasury Service: the single place that ever mutates a bank account's
// balance. Called from inside the approval-execution transaction (payments,
// transfers) and from incoming-transaction reconciliation, so "cash
// position" is always derived from an immutable ledger of transactions
// rather than being edited directly.
//
// All callers must pass a Prisma transaction client (`tx`) so the ledger
// entry, the balance update, and the daily snapshot commit atomically with
// the rest of the business operation (status changes, approval actions).

type TxClient = Prisma.TransactionClient;

export interface PostLedgerEntryInput {
  tenantId: string;
  accountId: string;
  currencyCode: string;
  type: TransactionType;
  amount: number; // always positive; direction implied by `type`
  reference: string;
  description?: string | null;
  transactionDate?: Date;
  relatedPaymentId?: string | null;
  relatedTransferId?: string | null;
  relatedIncomingId?: string | null;
}

const OUTFLOW_TYPES = new Set<TransactionType>(["PAYMENT_OUT", "TRANSFER_OUT"]);

export async function postLedgerEntry(tx: TxClient, input: PostLedgerEntryInput) {
  if (input.amount <= 0) {
    throw new Error("Ledger entries must have a positive amount");
  }

  const account = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.accountId } });
  const signedDelta = OUTFLOW_TYPES.has(input.type) ? -input.amount : input.amount;
  const newBalance = Number(account.currentBalance) + signedDelta;

  const transaction = await tx.transaction.create({
    data: {
      tenantId: input.tenantId,
      accountId: input.accountId,
      currencyCode: input.currencyCode,
      type: input.type,
      amount: input.amount,
      reference: input.reference,
      description: input.description ?? undefined,
      transactionDate: input.transactionDate ?? new Date(),
      relatedPaymentId: input.relatedPaymentId ?? undefined,
      relatedTransferId: input.relatedTransferId ?? undefined,
      relatedIncomingId: input.relatedIncomingId ?? undefined,
    },
  });

  const updatedAccount = await tx.bankAccount.update({
    where: { id: input.accountId },
    data: { currentBalance: newBalance, lastBalanceAt: new Date() },
  });

  // Upsert today's daily snapshot so Cash Position history / forecasting
  // baseline reflect the movement immediately.
  const today = new Date();
  const balanceDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const existing = await tx.accountBalance.findUnique({
    where: { accountId_balanceDate: { accountId: input.accountId, balanceDate } },
  });

  const availableBalance = newBalance - Number(updatedAccount.reservedAmount);
  if (existing) {
    await tx.accountBalance.update({
      where: { id: existing.id },
      data: { closingBalance: newBalance, availableBalance, source: "SYSTEM" },
    });
  } else {
    await tx.accountBalance.create({
      data: {
        tenantId: input.tenantId,
        accountId: input.accountId,
        currencyCode: input.currencyCode,
        balanceDate,
        openingBalance: Number(account.currentBalance),
        closingBalance: newBalance,
        availableBalance,
        source: "SYSTEM",
      },
    });
  }

  return { transaction, account: updatedAccount };
}
