import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { incomingService } from "./incoming.service";
import { createIncomingSchema, updateIncomingSchema } from "./incoming.schemas";

export const incomingRouter = Router();
incomingRouter.use(requirePermission(PERMISSIONS.INCOMING_VIEW, PERMISSIONS.INCOMING_MANAGE));
incomingRouter.use(requireModule(MODULE_KEYS.INCOMING));

incomingRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "valueDate", allowedSort: ["valueDate", "amount", "createdAt", "status"] });
    const { items, meta } = await incomingService.list(req.user!.tenantId, query, {
      status: req.query.status as string | undefined,
      destinationAccountId: req.query.destinationAccountId as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

incomingRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await incomingService.getById(req.user!.tenantId, req.params.id))));

incomingRouter.post(
  "/",
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
  validate(createIncomingSchema),
  asyncHandler(async (req, res) => created(res, await incomingService.create(req.user!.tenantId, req.body, req.user!.id)))
);

incomingRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
  validate(updateIncomingSchema),
  asyncHandler(async (req, res) => ok(res, await incomingService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

incomingRouter.post(
  "/:id/receive",
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
  asyncHandler(async (req, res) => ok(res, await incomingService.markReceived(req.user!.tenantId, req.params.id, req.user!.id)))
);

incomingRouter.post(
  "/:id/reconcile",
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
  asyncHandler(async (req, res) => ok(res, await incomingService.markReconciled(req.user!.tenantId, req.params.id, req.user!.id)))
);

incomingRouter.post(
  "/:id/cancel",
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
  asyncHandler(async (req, res) => ok(res, await incomingService.cancel(req.user!.tenantId, req.params.id, req.user!.id)))
);
