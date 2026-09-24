import { z } from "zod";

const quotaBase = z.object({
  paymentMethod: z.enum(["CHEQUE", "BANK_DRAFT"]),
  bankId: z.string().nullable().optional(), // null/omitted = all banks combined
  dailyAmountLimit: z.number().positive().nullable().optional(),
  dailyCountLimit: z.number().int().positive().nullable().optional(),
  currencyCode: z.string().length(3).default("MYR"),
  isActive: z.boolean().default(true),
});

const needsALimit = (v: { dailyAmountLimit?: number | null; dailyCountLimit?: number | null }) => v.dailyAmountLimit != null || v.dailyCountLimit != null;

export const createQuotaSchema = quotaBase.refine(needsALimit, { message: "Set a daily amount limit, a daily count limit, or both", path: ["dailyAmountLimit"] });
export const updateQuotaSchema = quotaBase.partial();
