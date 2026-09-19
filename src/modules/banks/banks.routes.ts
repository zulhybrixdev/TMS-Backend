import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { banksService } from "./banks.service";
import { createBankSchema, updateBankSchema } from "./banks.schemas";

export const banksRouter = Router();

banksRouter.get("/", requirePermission(PERMISSIONS.ACCOUNTS_VIEW, PERMISSIONS.BANKS_MANAGE), asyncHandler(async (req, res) => ok(res, await banksService.list(req.user!.tenantId))));
banksRouter.get("/:id", requirePermission(PERMISSIONS.ACCOUNTS_VIEW, PERMISSIONS.BANKS_MANAGE), asyncHandler(async (req, res) => ok(res, await banksService.getById(req.user!.tenantId, req.params.id))));

banksRouter.post(
  "/",
  requirePermission(PERMISSIONS.BANKS_MANAGE),
  validate(createBankSchema),
  asyncHandler(async (req, res) => created(res, await banksService.create(req.user!.tenantId, req.body, req.user!.id)))
);

banksRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.BANKS_MANAGE),
  validate(updateBankSchema),
  asyncHandler(async (req, res) => ok(res, await banksService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

banksRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.BANKS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await banksService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
