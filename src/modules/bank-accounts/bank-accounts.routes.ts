import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, created, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { parseListQuery } from "../../common/pagination";
import { PERMISSIONS } from "../../common/permissions";
import { bankAccountsService } from "./bank-accounts.service";
import { createBankAccountSchema, updateBankAccountSchema, recordBalanceSchema } from "./bank-accounts.schemas";

export const bankAccountsRouter = Router();
bankAccountsRouter.use(requirePermission(PERMISSIONS.ACCOUNTS_VIEW, PERMISSIONS.ACCOUNTS_MANAGE));

bankAccountsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "accountName", allowedSort: ["accountName", "currentBalance", "createdAt"] });
    const { items, meta } = await bankAccountsService.list(req.user!.tenantId, query, {
      bankId: req.query.bankId as string | undefined,
      currencyCode: req.query.currencyCode as string | undefined,
      status: req.query.status as string | undefined,
    });
    okPaginated(res, items, meta);
  })
);

bankAccountsRouter.get("/:id", asyncHandler(async (req, res) => ok(res, await bankAccountsService.getById(req.user!.tenantId, req.params.id))));

bankAccountsRouter.get(
  "/:id/balances",
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(7, parseInt(String(req.query.days ?? "90"), 10) || 90));
    ok(res, await bankAccountsService.getBalanceHistory(req.user!.tenantId, req.params.id, days));
  })
);

bankAccountsRouter.post(
  "/",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(createBankAccountSchema),
  asyncHandler(async (req, res) => created(res, await bankAccountsService.create(req.user!.tenantId, req.body, req.user!.id)))
);

bankAccountsRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(updateBankAccountSchema),
  asyncHandler(async (req, res) => ok(res, await bankAccountsService.update(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

bankAccountsRouter.post(
  "/:id/balance",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  validate(recordBalanceSchema),
  asyncHandler(async (req, res) => ok(res, await bankAccountsService.recordBalance(req.user!.tenantId, req.params.id, req.body, req.user!.id)))
);

bankAccountsRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.ACCOUNTS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await bankAccountsService.remove(req.user!.tenantId, req.params.id, req.user!.id)))
);
