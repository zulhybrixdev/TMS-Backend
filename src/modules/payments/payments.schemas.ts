import { z } from "zod";

// Forms send "" for a field the user left blank - treat that as "not provided".
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const paymentBase = z.object({
  beneficiaryName: z.string().min(2),
  // Cheque / bank draft payees have no account to pay into, so these are
  // only required for a bank TRANSFER (enforced in createPaymentSchema).
  beneficiaryAccount: z.preprocess(blankToUndefined, z.string().min(4).optional()),
  beneficiaryBank: z.preprocess(blankToUndefined, z.string().min(2).optional()),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  sourceAccountId: z.string(),
  // The AP due date: the day the cash is expected to leave the account.
  paymentDate: z.string(),
  paymentMethod: z.enum(["TRANSFER", "CHEQUE", "BANK_DRAFT"]).default("TRANSFER"),
  invoiceNumber: z.preprocess(blankToUndefined, z.string().max(100).optional()),
  description: z.string().optional(),
  reference: z.string().optional(),
  attachmentUrl: z.string().optional(),
});

export const createPaymentSchema = paymentBase.superRefine((v, ctx) => {
  if (v.paymentMethod !== "TRANSFER") return;
  if (!v.beneficiaryAccount) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaryAccount"], message: "Beneficiary account number is required for a bank transfer" });
  if (!v.beneficiaryBank) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaryBank"], message: "Beneficiary bank is required for a bank transfer" });
});

export const updatePaymentSchema = paymentBase.partial();

// Move a payment's due date without touching anything else - allowed right
// up until the payment is actually posted (see paymentsService.reschedule).
export const reschedulePaymentSchema = z.object({
  paymentDate: z.string().min(8),
  reason: z.string().max(500).optional(),
});

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
