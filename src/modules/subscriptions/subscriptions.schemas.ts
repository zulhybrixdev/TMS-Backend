import { z } from "zod";
import { PLAN_KEYS } from "../../common/plans";

export const changePlanSchema = z.object({
  planKey: z.enum([PLAN_KEYS.FREE, PLAN_KEYS.PRO, PLAN_KEYS.PRO_PLUS]),
});
