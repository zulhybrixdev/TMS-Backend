import { ApprovalEntityType, Prisma } from "@prisma/client";
import { prisma } from "../../common/prisma";
import { NotFoundError } from "../../common/errors";
import { auditService } from "../../common/audit.service";

type TxClient = Prisma.TransactionClient;

// Not a hard block - a rule scoped to a department nobody has *yet* is a
// legitimate way to define routing ahead of hiring into it. This is a
// heads-up returned alongside the saved rule (`departmentWarning`) so a
// genuine typo doesn't silently sit there matching nobody forever, without
// stopping the tenant from doing it deliberately.
async function departmentWarningFor(tenantId: string, department: string | null | undefined): Promise<string | null> {
  if (!department) return null;
  const match = await prisma.user.findFirst({ where: { tenantId, department, status: "ACTIVE", deletedAt: null } });
  return match ? null : `No active user currently has the department "${department}" - double-check the spelling, or this rule won't match anyone yet.`;
}

// Treasury Service: configurable approval rules. Resolution picks the most
// specific active rule matching entity type, currency, and amount band -
// this is what makes approval levels "configurable rather than hard-coded"
// per the business requirement. Custom rules are a Pro+ module (see
// plan.middleware's requireModule on the router); tenants without one
// always fall back to the safe single-level default in resolve().
export const approvalRulesService = {
  async list(tenantId: string, entityType?: ApprovalEntityType) {
    return prisma.approvalRule.findMany({
      where: { tenantId, ...(entityType ? { entityType } : {}) },
      orderBy: [{ entityType: "asc" }, { priority: "desc" }, { minAmount: "asc" }],
    });
  },

  async create(tenantId: string, input: any, actorId: string) {
    const rule = await prisma.approvalRule.create({ data: { ...input, tenantId } });
    await auditService.record({ tenantId, actorId, action: "approval_rule.create", entityType: "ApprovalRule", entityId: rule.id, afterState: rule });
    return { ...rule, departmentWarning: await departmentWarningFor(tenantId, rule.department) };
  },

  async update(tenantId: string, id: string, input: any, actorId: string) {
    const before = await prisma.approvalRule.findFirst({ where: { id, tenantId } });
    if (!before) throw new NotFoundError("Approval rule not found");
    const rule = await prisma.approvalRule.update({ where: { id }, data: input });
    await auditService.record({ tenantId, actorId, action: "approval_rule.update", entityType: "ApprovalRule", entityId: id, beforeState: before, afterState: rule });
    return { ...rule, departmentWarning: await departmentWarningFor(tenantId, rule.department) };
  },

  async remove(tenantId: string, id: string, actorId: string) {
    const rule = await prisma.approvalRule.findFirst({ where: { id, tenantId } });
    if (!rule) throw new NotFoundError("Approval rule not found");
    await prisma.approvalRule.delete({ where: { id } });
    await auditService.record({ tenantId, actorId, action: "approval_rule.delete", entityType: "ApprovalRule", entityId: id, beforeState: rule });
    return { deleted: true };
  },

  // Picks the highest-priority active rule whose amount band, currency, and
  // department (if any of those are specified on the rule) match. Falls
  // back to a safe single-level default so the system always has *some*
  // approval gate even with no rules configured (e.g. Free-tier tenants,
  // who cannot create custom rules at all). `department` is the
  // requester's own User.department - a rule with a department set only
  // matches requesters in that department; a rule with it unset matches
  // everyone, same wildcard convention as currencyCode. Tenants pick which
  // rule wins when several match via `priority`, same as before - this
  // doesn't add implicit "more specific wins" ranking on top of that.
  async resolve(tx: TxClient, tenantId: string, entityType: ApprovalEntityType, currencyCode: string, amount: number, department?: string | null) {
    const rules = await tx.approvalRule.findMany({
      where: { tenantId, entityType, isActive: true },
      orderBy: [{ priority: "desc" }, { minAmount: "desc" }],
    });

    const match = rules.find((r) => {
      const currencyOk = !r.currencyCode || r.currencyCode === currencyCode;
      const departmentOk = !r.department || r.department === department;
      const minOk = amount >= Number(r.minAmount);
      const maxOk = r.maxAmount === null || amount <= Number(r.maxAmount);
      return currencyOk && departmentOk && minOk && maxOk;
    });

    if (match) return match;

    return {
      id: null as string | null,
      requiredLevels: 1,
      requiredRoleLevel1: "Finance Checker",
      requiredRoleLevel2: null as string | null,
    };
  },
};
