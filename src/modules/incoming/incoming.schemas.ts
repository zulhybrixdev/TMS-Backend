import { z } from "zod";

export const createIncomingSchema = z.object({
  reference: z.string().optional(),
  sourceName: z.string().min(2),
  amount: z.number().positive(),
  currencyCode: z.string().length(3),
  destinationAccountId: z.string(),
  valueDate: z.string(),
  description: z.string().optional(),
});

export const updateIncomingSchema = createIncomingSchema.partial();
