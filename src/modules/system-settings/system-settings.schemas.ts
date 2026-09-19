import { z } from "zod";

export const upsertSettingSchema = z.object({
  value: z.string(),
  description: z.string().optional(),
});
