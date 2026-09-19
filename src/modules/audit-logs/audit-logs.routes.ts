import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, okPaginated } from "../../common/response";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { auditLogsService } from "./audit-logs.service";

// Tenant-scoped, self-serve audit trail - Pro+ exclusive (see
// common/plans.ts). Distinct from, and in addition to, the Platform
// Console's cross-tenant oversight (modules/platform/) which every tenant
// is subject to regardless of plan; this route only ever returns the
// calling tenant's own rows (auditLogsService.list scopes by tenantId).
export const auditLogsRouter = Router();
auditLogsRouter.use(requirePermission(PERMISSIONS.AUDIT_VIEW));
auditLogsRouter.use(requireModule(MODULE_KEYS.AUDIT));

auditLogsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "createdAt", allowedSort: ["createdAt"] });
    const { items, meta } = await auditLogsService.list(req.user!.tenantId, query, {
      entityType: req.query.entityType as string | undefined,
      actorId: req.query.actorId as string | undefined,
      action: req.query.action as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

auditLogsRouter.get("/entity-types", asyncHandler(async (req, res) => ok(res, await auditLogsService.distinctEntityTypes(req.user!.tenantId))));
