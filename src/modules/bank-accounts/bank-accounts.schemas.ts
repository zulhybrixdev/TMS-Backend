import { z } from "zod";

const siteName = z.string().trim().max(100).nullable().optional();

export const createBankAccountSchema = z
  .object({
    bankId: z.string(),
    accountName: z.string().min(2),
    accountNumber: z.string().min(4),
    currencyCode: z.string().length(3),
    accountType: z.enum(["OPERATING", "COLLECTION", "DISBURSEMENT", "RESERVE"]).default("OPERATING"),
    // May be negative for an account already in overdraft - bounded by the limit below.
    currentBalance: z.number().default(0),
    reservedAmount: z.number().min(0).default(0),
    minimumBalance: z.number().min(0).default(0),
    targetBalance: z.number().min(0).default(0),
    overdraftLimit: z.number().min(0).default(0),
    siteName,
  })
  .refine((v) => v.currentBalance >= -v.overdraftLimit, { message: "Balance cannot be more overdrawn than the overdraft limit", path: ["currentBalance"] });

export const updateBankAccountSchema = z.object({
  accountName: z.string().min(2).optional(),
  accountType: z.enum(["OPERATING", "COLLECTION", "DISBURSEMENT", "RESERVE"]).optional(),
  minimumBalance: z.number().min(0).optional(),
  targetBalance: z.number().min(0).optional(),
  reservedAmount: z.number().min(0).optional(),
  overdraftLimit: z.number().min(0).optional(),
  siteName,
  status: z.enum(["ACTIVE", "DORMANT", "CLOSED"]).optional(),
});

export const recordBalanceSchema = z.object({
  balanceDate: z.string(),
  closingBalance: z.number(),
  availableBalance: z.number().optional(),
});
