// Common Service: date-only helpers. Payment/incoming/transfer dates and
// balance snapshots are stored as SQL DATE (Prisma hands them back as UTC
// midnight), so every comparison here works on UTC-midnight Dates built
// from the *server's local calendar day* - never `new Date()` with a time
// component, which would silently exclude "today's" rows (a DATE column at
// 00:00Z is earlier than any time of day) for a server east of UTC.

export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

// "2026-09-24" (or any ISO string starting with one) / Date -> UTC midnight
// of that calendar date.
export function toDateOnly(input: string | Date): Date {
  if (typeof input === "string") return new Date(`${input.slice(0, 10)}T00:00:00.000Z`);
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

export function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

export function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

// Mon-Fri only - there is no public-holiday calendar, so a bank holiday
// counts as a business day here. Good enough for a float estimate; the
// clearing date is editable per transaction if a holiday matters.
export function addBusinessDays(d: Date, n: number): Date {
  let cursor = new Date(d);
  let remaining = n;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}

// [start, end) of a calendar day in the server's local time, for filtering
// timestamp columns (Transaction.transactionDate) by "that day".
export function localDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const end = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return { start, end };
}
