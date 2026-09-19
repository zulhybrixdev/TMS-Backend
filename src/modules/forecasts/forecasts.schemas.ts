import { z } from "zod";

export const createForecastSchema = z.object({
  accountId: z.string().optional(),
  currencyCode: z.string().length(3),
  forecastDate: z.string(),
  category: z.enum(["INFLOW", "OUTFLOW"]),
  amount: z.number().positive(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  description: z.string().optional(),
});

export const updateForecastSchema = createForecastSchema.partial();
