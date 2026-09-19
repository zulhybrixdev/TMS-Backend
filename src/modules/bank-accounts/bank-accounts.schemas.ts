import { z } from "zod";

export const createBankAccountSchema = z.object({
  bankId: z.string(),
  accountName: z.string().min(2),
  accountNumber: z.string().min(4),
  currencyCode: z.string().length(3),
  accountType: z.enum(["OPERATING", "COLLECTION", "DISBURSEMENT", "RESERVE"]).default("OPERATING"),
  currentBalance: z.number().min(0).default(0),
  reservedAmount: z.number().min(0).default(0),
  minimumBalance: z.number().min(0).default(0),
  targetBalance: z.number().min(0).default(0),
});

export const updateBankAccountSchema = z.object({
  accountName: z.string().min(2).optional(),
  accountType: z.enum(["OPERATING", "COLLECTION", "DISBURSEMENT", "RESERVE"]).optional(),
  minimumBalance: z.number().min(0).optional(),
  targetBalance: z.number().min(0).optional(),
  reservedAmount: z.number().min(0).optional(),
  status: z.enum(["ACTIVE", "DORMANT", "CLOSED"]).optional(),
});

export const recordBalanceSchema = z.object({
  balanceDate: z.string(),
  closingBalance: z.number(),
  availableBalance: z.number().optional(),
});
