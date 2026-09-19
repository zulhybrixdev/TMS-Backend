import { z } from "zod";

export const createBeneficiarySchema = z.object({
  nickname: z.string().min(2),
  accountName: z.string().min(2),
  accountNumber: z.string().min(4),
  bankName: z.string().min(2),
  currencyCode: z.string().length(3).optional(),
});

export const updateBeneficiarySchema = createBeneficiarySchema.partial().extend({
  isActive: z.boolean().optional(),
});
