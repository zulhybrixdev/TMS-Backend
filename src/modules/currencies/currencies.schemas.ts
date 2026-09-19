import { z } from "zod";

export const createCurrencySchema = z.object({
  code: z.string().length(3),
  name: z.string().min(2),
  symbol: z.string().min(1),
  isBase: z.boolean().default(false),
});

export const updateCurrencySchema = z.object({
  name: z.string().min(2).optional(),
  symbol: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  isBase: z.boolean().optional(),
});
