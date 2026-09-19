import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { beneficiariesService } from "./beneficiaries.service";
import { createBeneficiarySchema, updateBeneficiarySchema } from "./beneficiaries.schemas";

export const beneficiariesRouter = Router();
beneficiariesRouter.use(requirePermission(PERMISSIONS.BENEFICIARIES_VIEW, PERMISSIONS.BENEFICIARIES_MANAGE));
beneficiariesRouter.use(requireModule(MODULE_KEYS.BENEFICIARIES));

beneficiariesRouter.get(
  "/",
  asyncHandler(async (req, res) => ok(res, await beneficiariesService.list(req.user!.tenantId, req.query.search as string | undefined)))
);

beneficiariesRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await beneficiariesService.getById(req.user!.tenantId, req.params.id))));

beneficiariesRouter.post(
  "/",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  validate(createBeneficiarySchema),
  asyncHandler(async (req, res) => created(res, await beneficiariesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

beneficiariesRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  validate(updateBeneficiarySchema),
  asyncHandler(async (req, res) => ok(res, await beneficiariesService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

beneficiariesRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  asyncHandler(async (req, res) => ok(res, await beneficiariesService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
