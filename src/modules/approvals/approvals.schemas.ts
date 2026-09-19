import { z } from "zod";

export const actOnApprovalSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().max(1000).optional(),
});
