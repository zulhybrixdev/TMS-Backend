import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { dashboardService } from "./dashboard.service";

export const dashboardRouter = Router();
dashboardRouter.use(requirePermission(PERMISSIONS.DASHBOARD_VIEW));

dashboardRouter.get("/", asyncHandler(async (req, res) => ok(res, await dashboardService.getSummary(req.user!.tenantId, req.user!.roles))));
dashboardRouter.get("/onboarding", asyncHandler(async (req, res) => ok(res, await dashboardService.getOnboardingStatus(req.user!.tenantId))));
dashboardRouter.get(
  "/executive",
  requireModule(MODULE_KEYS.ADVANCED_INSIGHTS),
  asyncHandler(async (req, res) => ok(res, await dashboardService.getExecutiveSummary(req.user!.tenantId)))
);

const widgetPrefsSchema = z.object({ widgets: z.record(z.boolean()) });

// Saved dashboard layout - Pro+ only (see plans.ts MODULE_KEYS.ADVANCED_INSIGHTS).
dashboardRouter.get(
  "/widget-prefs",
  requireModule(MODULE_KEYS.ADVANCED_INSIGHTS),
  asyncHandler(async (req, res) => ok(res, await dashboardService.getWidgetPrefs(req.user!.id)))
);
dashboardRouter.patch(
  "/widget-prefs",
  requireModule(MODULE_KEYS.ADVANCED_INSIGHTS),
  validate(widgetPrefsSchema),
  asyncHandler(async (req, res) => ok(res, await dashboardService.saveWidgetPrefs(req.user!.id, req.body.widgets)))
);
