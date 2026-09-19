import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { usersService } from "./users.service";
import { createUserSchema, updateUserSchema, resetPasswordSchema } from "./users.schemas";

export const usersRouter = Router();

// Backs the approval rule form's department picklist (Administration ->
// Approval Rules), not the Users CRUD screen - deliberately not gated by
// USERS_MANAGE, since whoever can configure approval routing needs this
// list too, and those aren't necessarily the same person/permission.
usersRouter.get(
  "/departments",
  requirePermission(PERMISSIONS.APPROVAL_RULES_MANAGE, PERMISSIONS.USERS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await usersService.listDepartments(req.user!.tenantId)))
);

usersRouter.use(requirePermission(PERMISSIONS.USERS_MANAGE));

usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "createdAt", allowedSort: ["createdAt", "name", "email", "status"] });
    const { items, meta } = await usersService.list(req.user!.tenantId, query, {
      status: req.query.status as string | undefined,
      roleId: req.query.roleId as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

usersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await usersService.getById(req.user!.tenantId, req.params.id)))
);

usersRouter.post(
  "/",
  validate(createUserSchema),
  asyncHandler(async (req, res) => created(res, await usersService.create(req.user!.tenantId, req.body, req.user!.id)))
);

usersRouter.patch(
  "/:id",
  validate(updateUserSchema),
  asyncHandler(async (req, res) => ok(res, await usersService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

usersRouter.post(
  "/:id/reset-password",
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => ok(res, await usersService.resetPassword(req.user!.tenantId, req.params.id, req.body.newPassword, req.user!.id)))
);

usersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await usersService.softDelete(req.user!.tenantId, req.params.id, req.user!.id)))
);
