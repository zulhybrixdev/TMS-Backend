import { Router, Request } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { addDays, toDateOnly, todayDateOnly } from "../../common/dates";
import { forecastsService } from "./forecasts.service";
import { createForecastSchema, updateForecastSchema } from "./forecasts.schemas";

export const forecastsRouter = Router();
forecastsRouter.use(requirePermission(PERMISSIONS.FORECASTS_VIEW, PERMISSIONS.FORECASTS_MANAGE));
forecastsRouter.use(requireModule(MODULE_KEYS.FORECAST));

function projectionQuery(req: Request) {
  const today = todayDateOnly();
  const to = req.query.to ? toDateOnly(String(req.query.to)) : addDays(today, 30);
  const from = req.query.from ? toDateOnly(String(req.query.from)) : today;
  const filters = { accountId: req.query.accountId as string | undefined, currencyCode: req.query.currencyCode as string | undefined };
  return { from, to, filters };
}

// Company-wide series (base-currency, or the one currency asked for).
forecastsRouter.get(
  "/projection",
  asyncHandler(async (req, res) => {
    const { from, to, filters } = projectionQuery(req);
    ok(res, await forecastsService.getProjection(req.user!.tenantId, from, to, filters));
  })
);

// Same series plus the per-bank/account breakdown, overdue items and any
// currencies that could not be converted - what the Forecast screen shows.
forecastsRouter.get(
  "/projection/detail",
  asyncHandler(async (req, res) => {
    const { from, to, filters } = projectionQuery(req);
    ok(res, await forecastsService.getProjectionDetail(req.user!.tenantId, from, to, filters));
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
