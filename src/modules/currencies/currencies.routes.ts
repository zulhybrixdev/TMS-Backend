import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { authenticate } from "../../common/middleware/auth.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { currenciesService } from "./currencies.service";
import { createCurrencySchema, updateCurrencySchema } from "./currencies.schemas";

export const currenciesRouter = Router();
currenciesRouter.use(authenticate);

currenciesRouter.get("/", asyncHandler(async (_req, res) => ok(res, await currenciesService.list())));

currenciesRouter.post(
  "/",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate(createCurrencySchema),
  asyncHandler(async (req, res) => created(res, await currenciesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

currenciesRouter.patch(
  "/:code",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate(updateCurrencySchema),
  asyncHandler(async (req, res) => ok(res, await currenciesService.update(req.user!.tenantId, req.params.code, req.body, req.user!.id)))
);
