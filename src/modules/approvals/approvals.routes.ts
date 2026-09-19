import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { approvalsService } from "./approvals.service";
import { approvalRulesService } from "./approval-rules.service";
import { actOnApprovalSchema } from "./approvals.schemas";
import { createApprovalRuleSchema, updateApprovalRuleSchema } from "./approval-rules.schemas";

export const approvalsRouter = Router();
approvalsRouter.use(requirePermission(PERMISSIONS.APPROVALS_ACT, PERMISSIONS.PAYMENTS_CREATE, PERMISSIONS.TRANSFERS_CREATE));

approvalsRouter.get(
  "/pending",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req);
    const { items, meta } = await approvalsService.listPending(req.user!.tenantId, req.user!.roles, query);
    okPaginated(res, items, meta);
  })
);

approvalsRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req);
    const { items, meta } = await approvalsService.listMine(req.user!.tenantId, req.user!.id, query);
    okPaginated(res, items, meta);
  })
);

approvalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req);
    const { items, meta } = await approvalsService.listAll(req.user!.tenantId, query, {
      status: req.query.status as string | undefined,
      entityType: req.query.entityType as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

approvalsRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await approvalsService.getById(req.user!.tenantId, req.params.id))));

approvalsRouter.post(
  "/:id/act",
  requirePermission(PERMISSIONS.APPROVALS_ACT),
  validate(actOnApprovalSchema),
  asyncHandler(async (req, res) => {
    const result = await approvalsService.act(req.user!.tenantId, req.params.id, { id: req.user!.id, roles: req.user!.roles }, req.body.action, req.body.comment, req.ip);
    ok(res, result);
  })
);

// Configurable multi-level approval rules are a Pro+ module - Free/Pro
// tenants always fall back to the safe single-level default (see
// approval-rules.service#resolve).
export const approvalRulesRouter = Router();
approvalRulesRouter.use(requirePermission(PERMISSIONS.APPROVAL_RULES_MANAGE));
approvalRulesRouter.use(requireModule(MODULE_KEYS.APPROVAL_RULES));

approvalRulesRouter.get(
  "/",
  asyncHandler(async (req, res) => ok(res, await approvalRulesService.list(req.user!.tenantId, req.query.entityType as any)))
);

approvalRulesRouter.post(
  "/",
  validate(createApprovalRuleSchema),
  asyncHandler(async (req, res) => created(res, await approvalRulesService.create(req.user!.tenantId, req.body, req.user!.id)))
);

approvalRulesRouter.patch(
  "/:id",
  validate(updateApprovalRuleSchema),
  asyncHandler(async (req, res) => ok(res, await approvalRulesService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

approvalRulesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await approvalRulesService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
