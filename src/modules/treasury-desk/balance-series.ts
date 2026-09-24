import { Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { addDays, diffDays, isoDate, todayDateOnly } from "../../common/dates";

// Daily closing balance per account for every day in [from, to], carrying the
// last known balance forward across days with no snapshot - snapshots are
// only written when a balance actually changes (ledger posting or manual
// entry), so a quiet weekend has no row and would otherwise read as "no
// balance". null = before the account's first-ever snapshot (unknown).
// Today is always the live current balance, not a snapshot.
export async function dailyClosingBalances(tenantId: string, from: Date, to: Date): Promise<{ dates: string[]; byAccount: Map<string, (number | null)[]> }> {
  const nDays = diffDays(from, to) + 1;
  const dates = Array.from({ length: nDays }, (_, i) => isoDate(addDays(from, i)));

  const [inRange, before, accounts] = await Promise.all([
    prisma.accountBalance.findMany({
      where: { tenantId, balanceDate: { gte: from, lte: to } },
      select: { accountId: true, balanceDate: true, closingBalance: true },
      orderBy: { balanceDate: "asc" },
    }),
    // Last snapshot strictly before `from`, one per account - the carry-in.
    prisma.$queryRaw<{ account_id: string; closing_balance: Prisma.Decimal }[]>(Prisma.sql`
      SELECT ab.account_id, ab.closing_balance
      FROM account_balances ab
      JOIN (
        SELECT account_id, MAX(balance_date) AS d
        FROM account_balances
        WHERE tenant_id = ${tenantId} AND balance_date < ${isoDate(from)}
        GROUP BY account_id
      ) latest ON latest.account_id = ab.account_id AND latest.d = ab.balance_date
      WHERE ab.tenant_id = ${tenantId}`),
    prisma.bankAccount.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, currentBalance: true } }),
  ]);

  const carryIn = new Map(before.map((r) => [r.account_id, Number(r.closing_balance)]));
  const snapshotsByAccount = new Map<string, Map<string, number>>();
  for (const r of inRange) {
    const m = snapshotsByAccount.get(r.accountId) ?? new Map<string, number>();
    m.set(isoDate(r.balanceDate), Number(r.closingBalance));
    snapshotsByAccount.set(r.accountId, m);
  }

  const todayKey = isoDate(todayDateOnly());
  const byAccount = new Map<string, (number | null)[]>();
  for (const acc of accounts) {
    const snaps = snapshotsByAccount.get(acc.id);
    let last: number | null = carryIn.get(acc.id) ?? null;
    const series: (number | null)[] = [];
    for (const key of dates) {
      if (key === todayKey) last = Number(acc.currentBalance);
      else if (snaps?.has(key)) last = snaps.get(key)!;
      // A date after today is not history - leave it to the caller (projection).
      series.push(key > todayKey ? null : last);
    }
    byAccount.set(acc.id, series);
  }
  return { dates, byAccount };
}
