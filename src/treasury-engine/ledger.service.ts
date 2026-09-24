import { randomUUID } from "crypto";
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
  relatedBaId?: string | null;
}

const OUTFLOW_TYPES = new Set<TransactionType>(["PAYMENT_OUT", "TRANSFER_OUT", "BA_SETTLEMENT"]);

export async function postLedgerEntry(tx: TxClient, input: PostLedgerEntryInput) {
  if (input.amount <= 0) {
    throw new Error("Ledger entries must have a positive amount");
  }

  const signedDelta = OUTFLOW_TYPES.has(input.type) ? -input.amount : input.amount;

  // Increment atomically in the database rather than "read balance, add,
  // write back": two postings against the same account (say a payment and a
  // transfer released by the same sweep) would otherwise both read the old
  // balance and the later write would silently discard the earlier one.
  // The UPDATE also row-locks the account until commit, which is what
  // serialises the snapshot write below for that account.
  const updatedAccount = await tx.bankAccount.update({
    where: { id: input.accountId },
    data: { currentBalance: { increment: signedDelta }, lastBalanceAt: new Date() },
  });
  const newBalance = Number(updatedAccount.currentBalance);
  const previousBalance = newBalance - signedDelta;

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
      relatedBaId: input.relatedBaId ?? undefined,
    },
  });

  // Upsert today's daily snapshot so Cash Position history / forecasting
  // baseline reflect the movement immediately. INSERT ... ON DUPLICATE KEY
  // UPDATE (a locking, "current" read) instead of find-then-create: under
  // MySQL's repeatable-read isolation a plain SELECT can't see a snapshot row
  // another transaction committed a moment ago, so the follow-up INSERT would
  // hit the unique (account, date) key and fail the whole business operation.
  const today = new Date();
  const balanceDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const availableBalance = newBalance - Number(updatedAccount.reservedAmount);
  await tx.$executeRaw`
    INSERT INTO account_balances (id, tenant_id, account_id, currency_code, balance_date, opening_balance, closing_balance, available_balance, source, created_at)
    VALUES (${randomUUID()}, ${input.tenantId}, ${input.accountId}, ${input.currencyCode}, ${balanceDate}, ${previousBalance}, ${newBalance}, ${availableBalance}, 'SYSTEM', NOW(3))
    ON DUPLICATE KEY UPDATE closing_balance = VALUES(closing_balance), available_balance = VALUES(available_balance), source = 'SYSTEM'`;

  return { transaction, account: updatedAccount };
}
