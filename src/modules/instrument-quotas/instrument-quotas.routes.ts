import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { requireModule } from "../../common/middleware/plan.middleware";
import { MODULE_KEYS } from "../../common/plans";
import { toDateOnly, todayDateOnly } from "../../common/dates";
import { instrumentQuotasService } from "./instrument-quotas.service";
import { createQuotaSchema, updateQuotaSchema } from "./instrument-quotas.schemas";

export const instrumentQuotasRouter = Router();
instrumentQuotasRouter.use(requirePermission(PERMISSIONS.CASH_POSITION_VIEW, PERMISSIONS.ACCOUNTS_MANAGE, PERMISSIONS.PAYMENTS_VIEW));
instrumentQuotasRouter.use(requireModule(MODULE_KEYS.TREASURY_DESK));

instrumentQuotasRouter.get("/", asyncHandler(async (req, res) => ok(res, await instrumentQuotasService.list(req.user!.tenantId))));

instrumentQuotasRouter.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const date = req.query.date ? toDateOnly(String(req.query.date)) : todayDateOnly();
    ok(res, await instrumentQuotasService.usage(req.user!.tenantId, date));
  })
);

instrumentQuotasRouter.post(
  "/",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(createQuotaSchema),
  asyncHandler(async (req, res) => created(res, await instrumentQuotasService.create(req.user!.tenantId, req.body, req.user!.id)))
);

instrumentQuotasRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(updateQuotaSchema),
  asyncHandler(async (req, res) => ok(res, await instrumentQuotasService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

instrumentQuotasRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await instrumentQuotasService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
