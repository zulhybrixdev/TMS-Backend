import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { ssoConfigService } from "./sso-config.service";

export const ssoConfigRouter = Router();
ssoConfigRouter.use(requirePermission(PERMISSIONS.SETTINGS_MANAGE));
ssoConfigRouter.use(requireModule(MODULE_KEYS.SSO));

const upsertSchema = z.object({
  keycloakIdpAlias: z.string().min(1),
  ssoRequired: z.boolean(),
  autoProvisionUsers: z.boolean(),
  allowedEmailDomains: z.array(z.string().min(1)).optional(),
});

ssoConfigRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const config = await ssoConfigService.get(req.user!.tenantId);
    ok(res, config);
  })
);

ssoConfigRouter.put(
  "/",
  validate(upsertSchema),
  asyncHandler(async (req, res) => {
    const config = await ssoConfigService.upsert(req.user!.tenantId, req.body, req.user!.id);
    ok(res, config);
  })
);

ssoConfigRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const result = await ssoConfigService.remove(req.user!.tenantId, req.user!.id);
    ok(res, result);
  })
);
