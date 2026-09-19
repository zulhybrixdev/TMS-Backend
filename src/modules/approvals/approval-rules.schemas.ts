import { z } from "zod";

export const createApprovalRuleSchema = z.object({
  entityType: z.enum(["PAYMENT", "TRANSFER"]),
  currencyCode: z.string().length(3).optional(),
  // Matches against the requester's User.department - unset matches any
  // department, same wildcard semantics as currencyCode above.
  department: z.string().min(1).max(100).optional(),
  minAmount: z.number().min(0).default(0),
  maxAmount: z.number().min(0).optional(),
  requiredLevels: z.number().int().min(1).max(2).default(1),
  requiredRoleLevel1: z.string(),
  requiredRoleLevel2: z.string().optional(),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(0),
  // Null/omitted falls back to the tenant's approvals.default_sla_hours
  // system setting - see approvals.service.ts's computeDueAt.
  slaHours: z.number().int().min(1).optional(),
});

export const updateApprovalRuleSchema = createApprovalRuleSchema.partial();
