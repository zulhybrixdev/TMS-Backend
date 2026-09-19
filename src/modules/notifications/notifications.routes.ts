import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { notificationsService } from "./notifications.service";

export const notificationsRouter = Router();

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === "true";
    const items = await notificationsService.listForUser(req.user!.tenantId, req.user!.id, unreadOnly);
    ok(res, items);
  })
);

notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    await notificationsService.markRead(req.user!.tenantId, req.user!.id, req.params.id);
    ok(res, { marked: true });
  })
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    await notificationsService.markAllRead(req.user!.tenantId, req.user!.id);
    ok(res, { marked: true });
  })
);
