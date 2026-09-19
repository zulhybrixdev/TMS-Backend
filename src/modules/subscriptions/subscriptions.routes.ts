import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { subscriptionsService } from "./subscriptions.service";
import { changePlanSchema } from "./subscriptions.schemas";

export const subscriptionsRouter = Router();

subscriptionsRouter.get("/me", asyncHandler(async (req, res) => ok(res, await subscriptionsService.getMe(req.user!.tenantId))));

// Only the tenant Admin (whoever holds SETTINGS_MANAGE) can change the plan.
subscriptionsRouter.post(
  "/change",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate(changePlanSchema),
  asyncHandler(async (req, res) => {
    const result = await subscriptionsService.changePlan(req.user!.tenantId, req.body.planKey, { id: req.user!.id, name: req.user!.name, email: req.user!.email });
    ok(res, result);
  })
);
