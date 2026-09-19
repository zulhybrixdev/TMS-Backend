import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { systemSettingsService } from "./system-settings.service";
import { upsertSettingSchema } from "./system-settings.schemas";

export const systemSettingsRouter = Router();
systemSettingsRouter.use(requirePermission(PERMISSIONS.SETTINGS_MANAGE));

systemSettingsRouter.get("/", asyncHandler(async (req, res) => ok(res, await systemSettingsService.list(req.user!.tenantId))));

systemSettingsRouter.put(
  "/:key",
  validate(upsertSettingSchema),
  asyncHandler(async (req, res) =>
    ok(res, await systemSettingsService.set(req.user!.tenantId, req.params.key, req.body.value, req.user!.id, req.body.description))
  )
);
