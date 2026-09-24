import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null)); // "" -> null: the Malay text is optional

const base = z.object({
  type: z.enum(["INFO", "MAINTENANCE", "DOWNTIME"]),
  titleEn: z.string().trim().min(1, "An English title is required").max(160),
  titleMs: optionalText(160),
  messageEn: z.string().trim().min(1, "An English message is required").max(1500),
  messageMs: optionalText(1500),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  affectedFrom: z.coerce.date().nullish(),
  affectedTo: z.coerce.date().nullish(),
  persistent: z.boolean(),
  // Lock the whole system while it is live (see the Announcement model). Info notices cannot lock.
  blocking: z.boolean().default(false),
});

const rules = (v: { type: string; blocking: boolean; startsAt: Date; endsAt: Date; affectedFrom?: Date | null; affectedTo?: Date | null }, ctx: z.RefinementCtx) => {
  if (v.blocking && v.type === "INFO") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocking"], message: "Only maintenance or downtime can lock the system" });
  // The banner (and so the lock) is hidden at endsAt, so it must not end before the outage does.
  if (v.blocking && v.affectedTo && v.endsAt < v.affectedTo) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "Hide-at must not be before the affected window ends, or the lock would lift early" });
  if (v.endsAt <= v.startsAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "The end time must be after the start time" });
  if (!!v.affectedFrom !== !!v.affectedTo) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["affectedTo"], message: "Give both the start and the end of the affected window, or neither" });
  if (v.affectedFrom && v.affectedTo && v.affectedTo <= v.affectedFrom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["affectedTo"], message: "The affected window must end after it starts" });
};

export const createAnnouncementSchema = base.superRefine(rules);
// An edit always sends the whole announcement (the console's form), so the same rules apply.
export const updateAnnouncementSchema = base.superRefine(rules);
