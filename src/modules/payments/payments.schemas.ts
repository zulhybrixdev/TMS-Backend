import { z } from "zod";

export const createPaymentSchema = z.object({
  beneficiaryName: z.string().min(2),
  beneficiaryAccount: z.string().min(4),
  beneficiaryBank: z.string().min(2),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  sourceAccountId: z.string(),
  paymentDate: z.string(),
  description: z.string().optional(),
  reference: z.string().optional(),
  attachmentUrl: z.string().optional(),
});

export const updatePaymentSchema = createPaymentSchema.partial();

// Bulk payment upload: the frontend parses the uploaded CSV/XLSX into rows
// client-side and posts them as JSON (no server-side file parsing
// dependency needed). Deliberately loose here (z.record, not
// z.array(createPaymentSchema)) - each row is validated against
// createPaymentSchema individually inside payments.service's bulkCreate(),
// so one malformed row reports as a per-row failure instead of a single
// bad row (e.g. a typo'd amount) rejecting the entire batch with a 400.
// Rows are processed sequentially, not in parallel (each one runs its own
// document-number sequence transaction - see id-generator.ts), so this cap
// is really "how long is it reasonable for one upload request to take",
// not a hard technical ceiling. 2000 covers a large payroll run with
// headroom; still capped so a many-hundred-thousand-row CSV pasted by
// mistake doesn't tie up a request for minutes.
export const bulkCreatePaymentsSchema = z.object({
  payments: z.array(z.record(z.unknown())).min(1).max(2000),
});
