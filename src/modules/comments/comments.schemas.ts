import { z } from "zod";

export const createCommentSchema = z.object({
  entityType: z.enum(["PAYMENT", "TRANSFER"]),
  entityId: z.string().min(1),
  body: z.string().min(1).max(2000),
  // Resolved by the frontend's @mention autocomplete (picking a real tenant
  // user), not parsed out of free text server-side - more robust than
  // trying to fuzzy-match "@Ahmad" against user names/emails.
  mentionedUserIds: z.array(z.string()).max(20).optional(),
});
