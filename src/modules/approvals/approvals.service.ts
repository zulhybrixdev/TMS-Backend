import { ApprovalEntityType, ApprovalActionType, Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";
import { notificationsService } from "../notifications/notifications.service";
import { approvalRulesService } from "./approval-rules.service";
import { isDueForRelease, postPaymentToLedger } from "../payments/payment-release";
import { isTransferDue, postTransferToLedger } from "../transfers/transfer-release";
import { systemSettingsService, SETTING_KEYS } from "../system-settings/system-settings.service";
import { ParsedListQuery, buildMeta } from "../../common/pagination";

type TxClient = Prisma.TransactionClient;

const approvalInclude = {
  actions: { include: { actor: { select: { id: true, name: true, email: true } } }, orderBy: { actedAt: "asc" as const } },
  payment: { include: { sourceAccount: { include: { bank: true } } } },
  transfer: { include: { sourceAccount: { include: { bank: true } }, destinationAccount: { include: { bank: true } } } },
};

function requesterOf(request: any): string {
  return request.entityType === "PAYMENT" ? request.payment?.requestedById : request.transfer?.requestedById;
}

async function computeDueAt(tx: TxClient, tenantId: string, ruleId: string | null | undefined): Promise<Date> {
  let slaHours: number | null = null;
  if (ruleId) {
    const rule = await tx.approvalRule.findUnique({ where: { id: ruleId } });
    slaHours = rule?.slaHours ?? null;
  }
  if (slaHours === null) {
    slaHours = await systemSettingsService.getNumber(tenantId, SETTING_KEYS.APPROVAL_DEFAULT_SLA_HOURS);
  }
  return new Date(Date.now() + slaHours * 60 * 60 * 1000);
}

function labelOf(request: any): string {
  if (request.entityType === "PAYMENT") return `Payment ${request.payment?.paymentNumber} to ${request.payment?.beneficiaryName}`;
  return `Transfer ${request.transfer?.transferNumber}: ${request.transfer?.sourceAccount?.accountName} → ${request.transfer?.destinationAccount?.accountName}`;
}

// Treasury Service: the single workflow engine behind the Approval Center.
// Payments and Transfers call `createForEntity` when submitted; this module
// owns level progression, segregation-of-duties, execution (ledger posting)
// on final approval, and the full audit/notification trail.
export const approvalsService = {
  async createForEntity(
    tx: TxClient,
    input: { tenantId: string; entityType: ApprovalEntityType; paymentId?: string; transferId?: string; requestedById: string; amount: number; currencyCode: string }
  ) {
    const requester = await tx.user.findUnique({ where: { id: input.requestedById }, select: { department: true } });
    const rule = await approvalRulesService.resolve(tx, input.tenantId, input.entityType, input.currencyCode, input.amount, requester?.department);
    const dueAt = await computeDueAt(tx, input.tenantId, rule.id);

    const request = await tx.approvalRequest.create({
      data: {
        tenantId: input.tenantId,
        entityType: input.entityType,
        paymentId: input.paymentId,
        transferId: input.transferId,
        requestedById: input.requestedById,
        amount: input.amount,
        currencyCode: input.currencyCode,
        requiredLevels: rule.requiredLevels,
        currentLevel: 1,
        ruleId: rule.id ?? undefined,
        dueAt,
      },
    });

    await notifyLevelApprovers(tx, input.tenantId, rule.requiredRoleLevel1, input.entityType, input.amount, input.currencyCode, request.id);
    return request;
  },

  async getById(tenantId: string, id: string) {
    const request = await prisma.approvalRequest.findFirst({ where: { id, tenantId }, include: approvalInclude });
    if (!request) throw new NotFoundError("Approval request not found");
    return serialize(request);
  },

  // Requests currently awaiting action from the given user's role(s), so the
  // Approval Center only shows what this approver can actually act on.
  async listPending(tenantId: string, userRoles: string[], query: ParsedListQuery) {
    const where: any = { tenantId, status: "PENDING" };
    const rows = await prisma.approvalRequest.findMany({ where, include: approvalInclude, orderBy: { createdAt: "asc" } });
    const rules = await loadRulesFor(tenantId, rows);

    const eligible = rows.filter((r) => userRoles.includes(levelRoleFor(r, r.currentLevel, rules)));
    const total = eligible.length;
    const page = eligible.slice(query.skip, query.skip + query.take);
    return { items: page.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async listMine(tenantId: string, userId: string, query: ParsedListQuery) {
    const where: any = {
      tenantId,
      OR: [{ payment: { requestedById: userId } }, { transfer: { requestedById: userId } }],
    };
    const [rows, total] = await Promise.all([
      prisma.approvalRequest.findMany({ where, include: approvalInclude, orderBy: { createdAt: "desc" }, skip: query.skip, take: query.take }),
      prisma.approvalRequest.count({ where }),
    ]);
    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async listAll(tenantId: string, query: ParsedListQuery, filters: { status?: string; entityType?: string }) {
    const where: any = { tenantId };
    if (filters.status) where.status = filters.status;
    if (filters.entityType) where.entityType = filters.entityType;
    const [rows, total] = await Promise.all([
      prisma.approvalRequest.findMany({ where, include: approvalInclude, orderBy: { createdAt: "desc" }, skip: query.skip, take: query.take }),
      prisma.approvalRequest.count({ where }),
    ]);
    return { items: rows.map(serialize), meta: buildMeta(query.page, query.pageSize, total) };
  },

  async act(tenantId: string, requestId: string, actor: { id: string; roles: string[] }, action: "APPROVE" | "REJECT", comment: string | undefined, ip?: string) {
    return prisma.$transaction(async (tx) => {
      const request = await tx.approvalRequest.findFirst({
        where: { id: requestId, tenantId },
        include: { payment: true, transfer: true },
      });
      if (!request) throw new NotFoundError("Approval request not found");
      if (request.status !== "PENDING") throw new ConflictError("This approval request has already been actioned");

      const requesterId = request.paymentId ? request.payment!.requestedById : request.transfer!.requestedById;
      const allowSelfApproval = await systemSettingsService.getBool(tenantId, SETTING_KEYS.ALLOW_SELF_APPROVAL);
      if (!allowSelfApproval && requesterId === actor.id) {
        throw new ForbiddenError("You cannot approve your own request (segregation of duties)");
      }

      const roleForLevel = await resolveLevelRole(tx, request, request.currentLevel);
      if (!actor.roles.includes(roleForLevel)) {
        throw new ForbiddenError(`Requires role "${roleForLevel}" to act on this approval level`);
      }

      await tx.approvalAction.create({
        data: { tenantId, approvalRequestId: request.id, level: request.currentLevel, actorId: actor.id, action: action as ApprovalActionType, comment },
      });

      if (action === "REJECT") {
        await tx.approvalRequest.update({ where: { id: request.id }, data: { status: "REJECTED" } });
        await rejectEntity(tx, request);
        await notificationsService.notify({
          tenantId,
          userId: requesterId,
          title: "Request rejected",
          message: `${labelOf({ ...request, payment: request.payment, transfer: request.transfer })} was rejected.${comment ? ` Reason: ${comment}` : ""}`,
          type: "ALERT",
          relatedEntityType: request.entityType,
          relatedEntityId: request.paymentId ?? request.transferId ?? undefined,
        });
      } else {
        if (request.currentLevel < request.requiredLevels) {
          const rule = request.ruleId ? await tx.approvalRule.findUnique({ where: { id: request.ruleId } }) : null;
          const nextLevel = request.currentLevel + 1;
          const dueAt = await computeDueAt(tx, tenantId, request.ruleId);
          await tx.approvalRequest.update({ where: { id: request.id }, data: { currentLevel: nextLevel, dueAt, escalatedAt: null } });
          const nextRole = nextLevel === 2 ? rule?.requiredRoleLevel2 ?? "Finance Manager" : rule?.requiredRoleLevel1 ?? "Finance Checker";
          await notifyLevelApprovers(tx, tenantId, nextRole, request.entityType, Number(request.amount), request.currencyCode, request.id);
        } else {
          await tx.approvalRequest.update({ where: { id: request.id }, data: { status: "APPROVED" } });
          const { scheduledFor } = await executeEntity(tx, tenantId, request, actor.id);
          await notificationsService.notify({
            tenantId,
            userId: requesterId,
            title: "Request approved",
            message: scheduledFor
              ? `${labelOf({ ...request, payment: request.payment, transfer: request.transfer })} has been fully approved and is scheduled to post on ${scheduledFor.toISOString().slice(0, 10)}.`
              : `${labelOf({ ...request, payment: request.payment, transfer: request.transfer })} has been fully approved and processed.`,
            type: "APPROVAL",
            relatedEntityType: request.entityType,
            relatedEntityId: request.paymentId ?? request.transferId ?? undefined,
          });
        }
      }

      await auditService.record({
        tenantId,
        actorId: actor.id,
        action: action === "APPROVE" ? "approval.approve" : "approval.reject",
        entityType: "ApprovalRequest",
        entityId: request.id,
        afterState: { status: action === "APPROVE" ? "APPROVED_OR_ADVANCED" : "REJECTED", comment },
        ipAddress: ip,
      });

      const refreshed = await tx.approvalRequest.findUnique({ where: { id: request.id }, include: approvalInclude });
      return serialize(refreshed);
    });
  },

  // Periodic SLA sweep (see index.ts's setInterval). Global across every
  // tenant by design - this isn't a per-request route handler, so there's
  // no tenantId to scope to. Each overdue request is only ever escalated
  // once per level: escalatedAt gates it here, and act() clears it back to
  // null whenever a request moves to a new level (new level, new SLA
  // clock, so it's eligible to be escalated again if that one also stalls).
  async checkEscalations() {
    const overdue = await prisma.approvalRequest.findMany({
      where: { status: "PENDING", dueAt: { lt: new Date() }, escalatedAt: null },
    });

    for (const request of overdue) {
      const role = await resolveLevelRole(prisma as unknown as TxClient, request, request.currentLevel);
      await notifyLevelApprovers(prisma as unknown as TxClient, request.tenantId, role, request.entityType, Number(request.amount), request.currencyCode, request.id, true);
      await prisma.approvalRequest.update({ where: { id: request.id }, data: { escalatedAt: new Date() } });
    }
    return { escalated: overdue.length };
  },
};

// ApprovalRequest.ruleId has no Prisma relation declared (rule is reference
// data, not a foreign key the request cascades with), so the required role
// per level is resolved by looking the rule up separately.
async function loadRulesFor(tenantId: string, rows: { ruleId: string | null }[]) {
  const ids = Array.from(new Set(rows.map((r) => r.ruleId).filter((id): id is string => !!id)));
  if (ids.length === 0) return new Map<string, { requiredRoleLevel1: string; requiredRoleLevel2: string | null }>();
  const rules = await prisma.approvalRule.findMany({ where: { id: { in: ids }, tenantId } });
  return new Map(rules.map((r) => [r.id, r]));
}

function levelRoleFor(
  request: { ruleId: string | null },
  level: number,
  rules: Map<string, { requiredRoleLevel1: string; requiredRoleLevel2: string | null }>
): string {
  const rule = request.ruleId ? rules.get(request.ruleId) : undefined;
  if (!rule) return level === 2 ? "Finance Manager" : "Finance Checker";
  return level === 2 ? rule.requiredRoleLevel2 ?? "Finance Manager" : rule.requiredRoleLevel1;
}

// Resolve the role required for a given level, joining back to the rule
// (or the same default used at creation time).
async function resolveLevelRole(tx: TxClient, request: { ruleId: string | null }, level: number): Promise<string> {
  if (!request.ruleId) return level === 2 ? "Finance Manager" : "Finance Checker";
  const rule = await tx.approvalRule.findUnique({ where: { id: request.ruleId } });
  if (!rule) return level === 2 ? "Finance Manager" : "Finance Checker";
  return level === 2 ? rule.requiredRoleLevel2 ?? "Finance Manager" : rule.requiredRoleLevel1;
}

async function notifyLevelApprovers(
  tx: TxClient,
  tenantId: string,
  roleName: string,
  entityType: ApprovalEntityType,
  amount: number,
  currencyCode: string,
  requestId: string,
  isEscalation = false
) {
  const approvers = await tx.user.findMany({ where: { tenantId, status: "ACTIVE", deletedAt: null, roles: { some: { role: { name: roleName, tenantId } } } } });
  if (approvers.length === 0) return;
  const kind = entityType === "PAYMENT" ? "payment" : "transfer";
  await tx.notification.createMany({
    data: approvers.map((u) => ({
      tenantId,
      userId: u.id,
      title: isEscalation ? "Approval overdue" : "Approval required",
      message: isEscalation
        ? `A ${kind} of ${amount.toLocaleString()} ${currencyCode} has been awaiting your approval past its SLA - please action it.`
        : `A ${kind} of ${amount.toLocaleString()} ${currencyCode} is awaiting your approval.`,
      type: "APPROVAL" as const,
      relatedEntityType: "ApprovalRequest",
      relatedEntityId: requestId,
    })),
  });
}

async function rejectEntity(tx: TxClient, request: { entityType: ApprovalEntityType; paymentId: string | null; transferId: string | null }) {
  if (request.entityType === "PAYMENT" && request.paymentId) {
    await tx.payment.update({ where: { id: request.paymentId }, data: { status: "REJECTED" } });
  } else if (request.entityType === "TRANSFER" && request.transferId) {
    await tx.transfer.update({ where: { id: request.transferId }, data: { status: "REJECTED" } });
  }
}

async function executeEntity(tx: TxClient, tenantId: string, request: { entityType: ApprovalEntityType; paymentId: string | null; transferId: string | null }, actorId: string): Promise<{ scheduledFor?: Date }> {
  if (request.entityType === "PAYMENT" && request.paymentId) {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: request.paymentId } });
    // Cash leaves on the due date: a future-dated payment stays APPROVED and
    // is posted by the release sweep (payment-release.ts) on its day.
    if (!isDueForRelease(payment.paymentDate)) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: "APPROVED" } });
      return { scheduledFor: payment.paymentDate };
    }
    await postPaymentToLedger(tx, tenantId, payment);
  } else if (request.entityType === "TRANSFER" && request.transferId) {
    const transfer = await tx.transfer.findUniqueOrThrow({ where: { id: request.transferId } });
    if (!isTransferDue(transfer.transferDate)) {
      await tx.transfer.update({ where: { id: transfer.id }, data: { status: "APPROVED" } });
      return { scheduledFor: transfer.transferDate };
    }
    await postTransferToLedger(tx, tenantId, transfer.id);
  }
  return {};
}

function serialize(request: any) {
  return {
    id: request.id,
    entityType: request.entityType,
    status: request.status,
    currentLevel: request.currentLevel,
    requiredLevels: request.requiredLevels,
    amount: Number(request.amount),
    currencyCode: request.currencyCode,
    dueAt: request.dueAt,
    isOverdue: request.status === "PENDING" && !!request.dueAt && new Date(request.dueAt).getTime() < Date.now(),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    label: labelOf(request),
    requestedById: requesterOf(request),
    payment: request.payment
      ? {
          id: request.payment.id,
          paymentNumber: request.payment.paymentNumber,
          beneficiaryName: request.payment.beneficiaryName,
          sourceAccount: request.payment.sourceAccount?.accountName,
          bank: request.payment.sourceAccount?.bank?.name,
        }
      : null,
    transfer: request.transfer
      ? {
          id: request.transfer.id,
          transferNumber: request.transfer.transferNumber,
          sourceAccount: request.transfer.sourceAccount?.accountName,
          destinationAccount: request.transfer.destinationAccount?.accountName,
        }
      : null,
    actions: (request.actions ?? []).map((a: any) => ({
      id: a.id,
      level: a.level,
      action: a.action,
      comment: a.comment,
      actedAt: a.actedAt,
      actor: a.actor,
    })),
  };
}
