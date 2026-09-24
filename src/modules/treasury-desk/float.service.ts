import { Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { addBusinessDays, todayDateOnly } from "../../common/dates";

type Db = Pick<Prisma.TransactionClient, "incomingTransaction">;

export interface AccountFloat {
  day1: number; // clears by the next business day
  day2: number; // clears the business day after that
  later: number; // anything cleared further out (manual clearing date)
  total: number;
}

const EMPTY: AccountFloat = { day1: 0, day2: 0, later: 0, total: 0 };
const round2 = (n: number) => Math.round(n * 100) / 100;

// Treasury Service: cheque float. A received incoming transaction with a
// float period is booked straight away (it is in the account's ledger
// balance) but is not usable until its clearingDate - until then it is
// "float": day 1 float clears on the next business day, day 2 float the
// business day after. Derived live from incoming_transactions, so it needs
// no sweep and can never drift out of step with the data it summarises.
export const floatService = {
  async byAccount(tenantId: string, accountIds?: string[], db: Db = prisma): Promise<Map<string, AccountFloat>> {
    const today = todayDateOnly();
    const day1Cutoff = addBusinessDays(today, 1);
    const day2Cutoff = addBusinessDays(today, 2);

    const rows = await db.incomingTransaction.findMany({
      where: {
        tenantId,
        status: { in: ["RECEIVED", "RECONCILED"] },
        clearingDate: { gt: today },
        ...(accountIds ? { destinationAccountId: { in: accountIds } } : {}),
      },
      select: { destinationAccountId: true, amount: true, clearingDate: true },
    });

    const result = new Map<string, AccountFloat>();
    for (const row of rows) {
      const entry = result.get(row.destinationAccountId) ?? { ...EMPTY };
      const amount = Number(row.amount);
      const clearing = row.clearingDate!;
      if (clearing <= day1Cutoff) entry.day1 = round2(entry.day1 + amount);
      else if (clearing <= day2Cutoff) entry.day2 = round2(entry.day2 + amount);
      else entry.later = round2(entry.later + amount);
      entry.total = round2(entry.total + amount);
      result.set(row.destinationAccountId, entry);
    }
    return result;
  },

  async forAccount(tenantId: string, accountId: string, db: Db = prisma): Promise<AccountFloat> {
    return (await this.byAccount(tenantId, [accountId], db)).get(accountId) ?? { ...EMPTY };
  },

  empty(): AccountFloat {
    return { ...EMPTY };
  },
};
