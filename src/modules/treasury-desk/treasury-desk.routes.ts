import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { requireModule } from "../../common/middleware/plan.middleware";
import { MODULE_KEYS } from "../../common/plans";
import { toDateOnly, todayDateOnly } from "../../common/dates";
import { treasuryDeskService } from "./treasury-desk.service";

export const treasuryDeskRouter = Router();
treasuryDeskRouter.use(requirePermission(PERMISSIONS.CASH_POSITION_VIEW));
treasuryDeskRouter.use(requireModule(MODULE_KEYS.TREASURY_DESK));

const clampInt = (value: unknown, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, parseInt(String(value ?? fallback), 10) || fallback));

// Per-account daily position for a date (default today).
treasuryDeskRouter.get(
  "/daily",
  asyncHandler(async (req, res) => {
    const date = req.query.date ? toDateOnly(String(req.query.date)) : todayDateOnly();
    ok(res, await treasuryDeskService.getDaily(req.user!.tenantId, date));
  })
);

// Bank x date balances: recent actuals then the forward projection.
treasuryDeskRouter.get(
  "/balance-grid",
  asyncHandler(async (req, res) => ok(res, await treasuryDeskService.getBalanceGrid(req.user!.tenantId, clampInt(req.query.past, 5, 0, 30), clampInt(req.query.ahead, 10, 1, 60))))
);

treasuryDeskRouter.get("/reserves", asyncHandler(async (req, res) => ok(res, await treasuryDeskService.getReserves(req.user!.tenantId))));
