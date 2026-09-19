import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { securityPolicyService } from "./security-policy.service";

export const securityPolicyRouter = Router();
securityPolicyRouter.use(requirePermission(PERMISSIONS.SETTINGS_MANAGE));

securityPolicyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    ok(res, await securityPolicyService.get(req.user!.tenantId));
  })
);

securityPolicyRouter.put(
  "/",
  validate(z.object({ mfaRequired: z.boolean() })),
  asyncHandler(async (req, res) => {
    ok(res, await securityPolicyService.setMfaRequired(req.user!.tenantId, req.body.mfaRequired, req.user!.id));
  })
);
