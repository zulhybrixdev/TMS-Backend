import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { paymentTemplatesService } from "./payment-templates.service";
import { createPaymentTemplateSchema, updatePaymentTemplateSchema } from "./payment-templates.schemas";

export const paymentTemplatesRouter = Router();
paymentTemplatesRouter.use(requirePermission(PERMISSIONS.BENEFICIARIES_VIEW, PERMISSIONS.BENEFICIARIES_MANAGE));
paymentTemplatesRouter.use(requireModule(MODULE_KEYS.BENEFICIARIES));

paymentTemplatesRouter.get("/", asyncHandler(async (req, res) => ok(res, await paymentTemplatesService.list(req.user!.tenantId))));
paymentTemplatesRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await paymentTemplatesService.getById(req.user!.tenantId, req.params.id))));

paymentTemplatesRouter.post(
  "/",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  validate(createPaymentTemplateSchema),
  asyncHandler(async (req, res) => created(res, await paymentTemplatesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

paymentTemplatesRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  validate(updatePaymentTemplateSchema),
  asyncHandler(async (req, res) => ok(res, await paymentTemplatesService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

paymentTemplatesRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.BENEFICIARIES_MANAGE),
  asyncHandler(async (req, res) => ok(res, await paymentTemplatesService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);

// Requires PAYMENTS_CREATE (not just BENEFICIARIES_MANAGE) since this
// actually creates a real DRAFT Payment, same gate as POST /api/payments.
paymentTemplatesRouter.post(
  "/:id/use",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  asyncHandler(async (req, res) => created(res, await paymentTemplatesService.useTemplate(req.user!.tenantId, req.params.id, req.user!.id, req.body ?? {})))
);
