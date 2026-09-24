import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { requireModule } from "../../common/middleware/plan.middleware";
import { MODULE_KEYS } from "../../common/plans";
import { bankerAcceptancesService } from "./banker-acceptances.service";
import { createBankerAcceptanceSchema, settleBankerAcceptanceSchema } from "./banker-acceptances.schemas";

export const bankerAcceptancesRouter = Router();
bankerAcceptancesRouter.use(requirePermission(PERMISSIONS.CASH_POSITION_VIEW, PERMISSIONS.ACCOUNTS_MANAGE));
bankerAcceptancesRouter.use(requireModule(MODULE_KEYS.TREASURY_DESK));

bankerAcceptancesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "maturityDate", allowedSort: ["maturityDate", "drawdownDate", "faceAmount", "createdAt", "status"] });
    const { items, meta } = await bankerAcceptancesService.list(req.user!.tenantId, query, { status: req.query.status as string | undefined });
    okPaginated(res, items, meta);
  })
);

bankerAcceptancesRouter.get("/summary", asyncHandler(async (req, res) => ok(res, await bankerAcceptancesService.summary(req.user!.tenantId))));

bankerAcceptancesRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await bankerAcceptancesService.getById(req.user!.tenantId, req.params.id))));

// Drawing down / settling a facility moves real cash, so it needs the same
// permission as editing a bank account's balance.
bankerAcceptancesRouter.post(
  "/",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(createBankerAcceptanceSchema),
  asyncHandler(async (req, res) => created(res, await bankerAcceptancesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

bankerAcceptancesRouter.post(
  "/:id/settle",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(settleBankerAcceptanceSchema),
  asyncHandler(async (req, res) => ok(res, await bankerAcceptancesService.settle(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);
