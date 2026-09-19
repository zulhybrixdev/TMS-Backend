import { z } from "zod";

export const createPaymentTemplateSchema = z.object({
  name: z.string().min(2),
  beneficiaryName: z.string().min(2),
  beneficiaryAccount: z.string().min(4),
  beneficiaryBank: z.string().min(2),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  sourceAccountId: z.string(),
  description: z.string().optional(),
  reference: z.string().optional(),
  // NONE (default) = manual "Use" reuse only, never auto-created.
  frequency: z.enum(["NONE", "WEEKLY", "MONTHLY"]).optional(),
  nextRunDate: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const updatePaymentTemplateSchema = createPaymentTemplateSchema.partial();
