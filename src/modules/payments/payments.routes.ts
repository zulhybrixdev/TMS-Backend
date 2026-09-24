import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { paymentsService } from "./payments.service";
import { createPaymentSchema, updatePaymentSchema, bulkCreatePaymentsSchema, reschedulePaymentSchema } from "./payments.schemas";

export const paymentsRouter = Router();
paymentsRouter.use(requirePermission(PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_CREATE));

paymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "createdAt", allowedSort: ["createdAt", "amount", "paymentDate", "status"] });
    const { items, meta } = await paymentsService.list(req.user!.tenantId, query, {
      status: req.query.status as string | undefined,
      sourceAccountId: req.query.sourceAccountId as string | undefined,
      paymentMethod: req.query.paymentMethod as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

paymentsRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await paymentsService.getById(req.user!.tenantId, req.params.id))));

paymentsRouter.post(
  "/",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  validate(createPaymentSchema),
  asyncHandler(async (req, res) => created(res, await paymentsService.create(req.user!.tenantId, req.body, req.user!.id)))
);

paymentsRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  validate(updatePaymentSchema),
  asyncHandler(async (req, res) => ok(res, await paymentsService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

// Pro/Pro+ only - see common/plans.ts MODULE_KEYS.BENEFICIARIES.
paymentsRouter.post(
  "/bulk",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  requireModule(MODULE_KEYS.BENEFICIARIES),
  validate(bulkCreatePaymentsSchema),
  asyncHandler(async (req, res) => ok(res, await paymentsService.bulkCreate(req.user!.tenantId, req.body.payments, req.user!.id)))
);

paymentsRouter.post(
  "/:id/submit",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  asyncHandler(async (req, res) => ok(res, await paymentsService.submit(req.user!.tenantId, req.params.id, req.user!.id)))
);

paymentsRouter.post(
  "/:id/reschedule",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  validate(reschedulePaymentSchema),
  asyncHandler(async (req, res) => ok(res, await paymentsService.reschedule(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

paymentsRouter.post(
  "/:id/cancel",
  requirePermission(PERMISSIONS.PAYMENTS_CREATE),
  asyncHandler(async (req, res) => ok(res, await paymentsService.cancel(req.user!.tenantId, req.params.id, req.user!.id)))
);
