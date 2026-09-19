import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { transfersService } from "./transfers.service";
import { createTransferSchema } from "./transfers.schemas";

export const transfersRouter = Router();
transfersRouter.use(requirePermission(PERMISSIONS.TRANSFERS_VIEW, PERMISSIONS.TRANSFERS_CREATE));
transfersRouter.use(requireModule(MODULE_KEYS.TRANSFERS));

transfersRouter.get("/recommendations", asyncHandler(async (req, res) => ok(res, await transfersService.getRecommendations(req.user!.tenantId))));

transfersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "createdAt", allowedSort: ["createdAt", "amount", "transferDate", "status"] });
    const { items, meta } = await transfersService.list(req.user!.tenantId, query, {
      status: req.query.status as string | undefined,
      sourceAccountId: req.query.sourceAccountId as string | undefined,
      destinationAccountId: req.query.destinationAccountId as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

transfersRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await transfersService.getById(req.user!.tenantId, req.params.id))));

transfersRouter.post(
  "/",
  requirePermission(PERMISSIONS.TRANSFERS_CREATE),
  validate(createTransferSchema),
  asyncHandler(async (req, res) => created(res, await transfersService.create(req.user!.tenantId, req.body, req.user!.id)))
);

transfersRouter.post(
  "/:id/submit",
  requirePermission(PERMISSIONS.TRANSFERS_CREATE),
  asyncHandler(async (req, res) => ok(res, await transfersService.submit(req.user!.tenantId, req.params.id, req.user!.id)))
);

transfersRouter.post(
  "/:id/cancel",
  requirePermission(PERMISSIONS.TRANSFERS_CREATE),
  asyncHandler(async (req, res) => ok(res, await transfersService.cancel(req.user!.tenantId, req.params.id, req.user!.id)))
);
