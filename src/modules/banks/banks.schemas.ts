import { z } from "zod";

export const createBankSchema = z.object({
  name: z.string().min(2),
  swiftCode: z.string().optional(),
  country: z.string().default("MY"),
});

export const updateBankSchema = z.object({
  name: z.string().min(2).optional(),
  swiftCode: z.string().optional(),
  country: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
