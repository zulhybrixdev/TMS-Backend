import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { rolesService } from "./roles.service";
import { createRoleSchema, updateRoleSchema } from "./roles.schemas";

export const rolesRouter = Router();
rolesRouter.use(requirePermission(PERMISSIONS.ROLES_MANAGE));

rolesRouter.get("/", asyncHandler(async (req, res) => ok(res, await rolesService.list(req.user!.tenantId))));
rolesRouter.get("/permissions", asyncHandler(async (_req, res) => ok(res, await rolesService.listPermissions())));
rolesRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await rolesService.getById(req.user!.tenantId, req.params.id))));

rolesRouter.post(
  "/",
  validate(createRoleSchema),
  asyncHandler(async (req, res) => created(res, await rolesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

rolesRouter.patch(
  "/:id",
  validate(updateRoleSchema),
  asyncHandler(async (req, res) => ok(res, await rolesService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

rolesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await rolesService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
