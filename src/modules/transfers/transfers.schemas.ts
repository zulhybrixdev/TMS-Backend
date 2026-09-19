import { z } from "zod";

export const createTransferSchema = z.object({
  sourceAccountId: z.string(),
  destinationAccountId: z.string(),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  reason: z.string().optional(),
  transferDate: z.string(),
  suggestedAmount: z.number().optional(),
  isSystemRecommended: z.boolean().default(false),
});
