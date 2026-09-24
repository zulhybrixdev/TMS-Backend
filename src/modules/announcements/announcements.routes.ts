import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { announcementsService } from "./announcements.service";

// Public and unauthenticated on purpose: the sign-in page needs to show a
// downtime notice to people who cannot sign in. It only ever returns
// announcements that are live right now, and only what was written for
// display (no admin ids, no drafts).
export const announcementsPublicRouter = Router();
announcementsPublicRouter.get("/active", asyncHandler(async (_req, res) => ok(res, await announcementsService.listActive())));
