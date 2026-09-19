import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { forecastsService } from "./forecasts.service";
import { createForecastSchema, updateForecastSchema } from "./forecasts.schemas";

export const forecastsRouter = Router();
forecastsRouter.use(requirePermission(PERMISSIONS.FORECASTS_VIEW, PERMISSIONS.FORECASTS_MANAGE));
forecastsRouter.use(requireModule(MODULE_KEYS.FORECAST));

forecastsRouter.get(
  "/projection",
  asyncHandler(async (req, res) => {
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 86400000);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    ok(res, await forecastsService.getProjection(req.user!.tenantId, from, to));
  })
);

forecastsRouter.get(
  "/",
  asyncHandler(async (req, res) =>
    ok(
      res,
      await forecastsService.list(req.user!.tenantId, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        accountId: req.query.accountId as string | undefined,
      })
    )
  )
);

forecastsRouter.post(
  "/",
  requirePermission(PERMISSIONS.FORECASTS_MANAGE),
  validate(createForecastSchema),
  asyncHandler(async (req, res) => created(res, await forecastsService.create(req.user!.tenantId, req.body, req.user!.id)))
);

forecastsRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.FORECASTS_MANAGE),
  validate(updateForecastSchema),
  asyncHandler(async (req, res) => ok(res, await forecastsService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

forecastsRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.FORECASTS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await forecastsService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
