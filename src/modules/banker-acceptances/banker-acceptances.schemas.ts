import { z } from "zod";

export const createBankerAcceptanceSchema = z
  .object({
    referenceNo: z.string().trim().min(2).max(100),
    creditAccountId: z.string(),
    // Where the BA is repaid from at maturity - defaults to the account it was credited to.
    settlementAccountId: z.string().optional(),
    faceAmount: z.number().positive(),
    // Cash actually credited by the bank on drawdown (face less discount/fees).
    proceedsAmount: z.number().positive(),
    drawdownDate: z.string().min(8),
    maturityDate: z.string().min(8),
    description: z.string().max(500).optional(),
  })
  .refine((v) => v.proceedsAmount <= v.faceAmount, { message: "Proceeds cannot exceed the face amount", path: ["proceedsAmount"] })
  .refine((v) => v.maturityDate > v.drawdownDate, { message: "Maturity must be after the drawdown date", path: ["maturityDate"] });

export const settleBankerAcceptanceSchema = z
  .object({
    settledDate: z.string().min(8).optional(),
    // What the bank actually debited - defaults to the face amount.
    settledAmount: z.number().positive().optional(),
  })
  .default({});
