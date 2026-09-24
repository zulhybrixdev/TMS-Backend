import { z } from "zod";

export const createIncomingSchema = z.object({
  reference: z.string().optional(),
  sourceName: z.string().min(2),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  destinationAccountId: z.string(),
  // The AR due date: the day the money is expected to land.
  valueDate: z.string(),
  invoiceNumber: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(100).optional()),
  // Cheque float: business days before the funds are usable once received
  // (0 = cleared immediately, 1 = day 1 float, 2 = day 2 float).
  floatDays: z.number().int().min(0).max(2).default(0),
  description: z.string().optional(),
});

export const updateIncomingSchema = createIncomingSchema.partial();

// Body of POST /:id/receive - both optional: the float chosen when the
// transaction was recorded is the default, and can be corrected here since
// what really matters (cheque or cash, clearing period) is only known when
// the money actually arrives.
export const receiveIncomingSchema = z
  .object({
    floatDays: z.number().int().min(0).max(2).optional(),
    clearingDate: z.string().min(8).optional(),
  })
  .default({});

export const rescheduleIncomingSchema = z.object({
  valueDate: z.string().min(8),
  reason: z.string().max(500).optional(),
});
