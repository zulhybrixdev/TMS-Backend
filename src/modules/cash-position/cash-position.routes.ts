import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { cashPositionService } from "./cash-position.service";

export const cashPositionRouter = Router();
cashPositionRouter.use(requirePermission(PERMISSIONS.CASH_POSITION_VIEW));

cashPositionRouter.get("/", asyncHandler(async (req, res) => ok(res, await cashPositionService.getSummary(req.user!.tenantId))));

// FX-converted consolidated total - Pro+ only.
cashPositionRouter.get(
  "/consolidated",
  requireModule(MODULE_KEYS.ADVANCED_INSIGHTS),
  asyncHandler(async (req, res) => ok(res, await cashPositionService.getConsolidated(req.user!.tenantId)))
);

cashPositionRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const period = (req.query.period as "daily" | "weekly" | "monthly") || "daily";
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(to.getTime() - 30 * 86400000);
    ok(res, await cashPositionService.getHistory(req.user!.tenantId, period, from, to));
  })
);
