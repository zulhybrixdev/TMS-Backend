import { z } from "zod";
import { PLAN_KEYS } from "../../common/plans";

export const platformLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const setTenantSubscriptionSchema = z.object({
  planKey: z.enum([PLAN_KEYS.FREE, PLAN_KEYS.PRO, PLAN_KEYS.PRO_PLUS]),
  status: z.enum(["ACTIVE", "PAST_DUE", "CANCELED", "PENDING_PAYMENT"]).optional(),
});

export const setPocModeSchema = z.object({
  pocMode: z.boolean(),
});
