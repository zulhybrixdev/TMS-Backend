import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/async-handler";
import { ok, created } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { ForbiddenError, BadRequestError } from "../../common/errors";
import { PERMISSIONS } from "../../common/permissions";
import { commentsService } from "./comments.service";
import { createCommentSchema } from "./comments.schemas";

export const commentsRouter = Router();

// Comments span two entity types with two different view permissions, so
// the gate is per-request (which entityType is this?) rather than a single
// static requirePermission(...) on the whole router.
function requireEntityViewAccess(entityType: unknown, permissions: string[]) {
  if (entityType === "PAYMENT" && !permissions.includes(PERMISSIONS.PAYMENTS_VIEW) && !permissions.includes(PERMISSIONS.PAYMENTS_CREATE)) {
    throw new ForbiddenError("You don't have access to payments");
  }
  if (entityType === "TRANSFER" && !permissions.includes(PERMISSIONS.TRANSFERS_VIEW) && !permissions.includes(PERMISSIONS.TRANSFERS_CREATE)) {
    throw new ForbiddenError("You don't have access to transfers");
  }
  if (entityType !== "PAYMENT" && entityType !== "TRANSFER") {
    throw new BadRequestError("entityType must be PAYMENT or TRANSFER");
  }
}

const listQuerySchema = z.object({ entityType: z.enum(["PAYMENT", "TRANSFER"]), entityId: z.string().min(1) });

commentsRouter.get(
  "/mentionable-users",
  asyncHandler(async (req, res) => ok(res, await commentsService.mentionableUsers(req.user!.tenantId)))
);

commentsRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.query as unknown as { entityType: "PAYMENT" | "TRANSFER"; entityId: string };
    requireEntityViewAccess(entityType, req.user!.permissions);
    ok(res, await commentsService.list(req.user!.tenantId, entityType, entityId));
  })
);

commentsRouter.post(
  "/",
  validate(createCommentSchema),
  asyncHandler(async (req, res) => {
    requireEntityViewAccess(req.body.entityType, req.user!.permissions);
    created(res, await commentsService.create(req.user!.tenantId, req.user!.id, req.body));
  })
);

commentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const isPrivileged = req.user!.permissions.includes(PERMISSIONS.SETTINGS_MANAGE);
    ok(res, await commentsService.remove(req.user!.tenantId, req.user!.id, req.params.id, isPrivileged));
  })
);
