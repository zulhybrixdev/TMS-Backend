import { prisma } from "../../common/prisma";
import { cashPositionService } from "../cash-position/cash-position.service";
import { forecastsService } from "../forecasts/forecasts.service";
import { approvalsService } from "../approvals/approvals.service";
import { todayDateOnly } from "../../common/dates";

// Treasury Service: single aggregation point behind the Dashboard screen -
// combines cash position, pipeline totals, pending approvals, recommended
// transfers, a 30-day cash-flow trend, a forward-looking forecast, and
// alerts, so the frontend makes one call instead of ten.
export const dashboardService = {
  async getSummary(tenantId: string, userRoles: string[]) {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const since30 = new Date(now.getTime() - 30 * 86400000);

    const [position, projection, pending, incomingTotals, outgoingTotals, staleAccounts, recentAuditCount, trend] = await Promise.all([
      cashPositionService.getSummary(tenantId),
      forecastsService.getProjection(tenantId, todayDateOnly(), in30),
      approvalsService.listPending(tenantId, userRoles, parseFakeQuery()),
      prisma.incomingTransaction.aggregate({ _sum: { amount: true }, where: { tenantId, status: "EXPECTED", valueDate: { gte: todayDateOnly(), lte: in30 } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { tenantId, status: { in: ["PENDING_APPROVAL", "APPROVED"] }, paymentDate: { gte: todayDateOnly(), lte: in30 } } }),
      prisma.bankAccount.findMany({ where: { tenantId, status: "ACTIVE", deletedAt: null, lastBalanceAt: { lt: since30 } }, select: { id: true, accountName: true, lastBalanceAt: true } }),
      prisma.auditLog.count({ where: { tenantId, createdAt: { gte: since30 } } }),
      cashPositionService.getHistory(tenantId, "daily", since30, now),
    ]);

    const alerts = buildAlerts(position, staleAccounts);

    return {
      totals: {
        totalCash: position.totalCash,
        availableCash: position.availableCash,
        minimumRequired: position.minimumRequired,
        totalShortfall: position.totalShortfall,
        totalExcess: position.totalExcess,
        excessOverTarget: position.excessOverTarget,
      },
      cashByBank: position.byBank,
      cashByCurrency: position.byCurrency,
      incoming30d: Number(incomingTotals._sum.amount ?? 0),
      outgoing30d: Number(outgoingTotals._sum.amount ?? 0),
      pendingApprovalsCount: pending.meta.total,
      pendingApprovals: pending.items.slice(0, 5),
      recommendations: position.recommendations,
      cashFlowTrend: trend,
      forecast30d: projection,
      projectedBalanceEnd: projection.length ? projection[projection.length - 1].projectedBalance : position.availableCash,
      alerts,
      recentAuditCount,
      accountsInShortfall: position.accountsInShortfall,
    };
  },

  // Guided onboarding checklist (Dashboard banner, frontend hides it once
  // every step is true) - derived from existing data rather than a new
  // "dismissed"-style table, so it never goes stale and never needs its
  // own persistence/reset logic.
  async getOnboardingStatus(tenantId: string) {
    const [bankAccountCount, userCount, approvalRuleCount, paymentCount] = await Promise.all([
      prisma.bankAccount.count({ where: { tenantId, deletedAt: null } }),
      prisma.user.count({ where: { tenantId, deletedAt: null } }),
      prisma.approvalRule.count({ where: { tenantId } }),
      prisma.payment.count({ where: { tenantId, deletedAt: null } }),
    ]);

    return {
      hasBankAccount: bankAccountCount > 0,
      hasTeam: userCount > 1,
      hasApprovalRule: approvalRuleCount > 0,
      hasPayment: paymentCount > 0,
    };
  },

  // Saved Dashboard layout (Pro+ - MODULE_KEYS.ADVANCED_INSIGHTS) - a plain
  // JSON blob keyed by widget id -> visible boolean, one row (User itself),
  // no new table. See User.dashboardWidgets in schema.prisma.
  async getWidgetPrefs(userId: string): Promise<Record<string, boolean>> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { dashboardWidgets: true } });
    return (user?.dashboardWidgets as Record<string, boolean> | null) ?? {};
  },

  async saveWidgetPrefs(userId: string, prefs: Record<string, boolean>): Promise<Record<string, boolean>> {
    await prisma.user.update({ where: { id: userId }, data: { dashboardWidgets: prefs } });
    return prefs;
  },

  // Executive/CFO dashboard - Pro+ only (MODULE_KEYS.ADVANCED_INSIGHTS).
  // Board/CFO-level KPIs on top of data every other screen already
  // computes from - no new data collection, just a different rollup of it.
  async getExecutiveSummary(tenantId: string) {
    const now = new Date();
    const since90 = new Date(now.getTime() - 90 * 86400000);
    const since6mo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [cashTrend90d, processedPayments, completedApprovals, topBeneficiaries] = await Promise.all([
      cashPositionService.getHistory(tenantId, "daily", since90, now),
      prisma.payment.findMany({
        where: { tenantId, deletedAt: null, status: "PROCESSED", createdAt: { gte: since6mo } },
        select: { amount: true, createdAt: true },
      }),
      prisma.approvalRequest.findMany({
        where: { tenantId, status: { in: ["APPROVED", "REJECTED"] } },
        select: { createdAt: true, updatedAt: true, dueAt: true },
      }),
      prisma.payment.groupBy({
        by: ["beneficiaryName", "beneficiaryAccount"],
        where: { tenantId, deletedAt: null, status: "PROCESSED" },
        _sum: { amount: true },
        _count: true,
        orderBy: { _sum: { amount: "desc" } },
        take: 5,
      }),
    ]);

    const monthly = new Map<string, { count: number; total: number }>();
    for (const p of processedPayments) {
      const key = p.createdAt.toISOString().slice(0, 7);
      const entry = monthly.get(key) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(p.amount);
      monthly.set(key, entry);
    }
    const paymentVolumeByMonth = Array.from(monthly.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }));

    // SLA compliance here is an approximation: it compares the final
    // decision time (updatedAt, which flips only on the terminal
    // APPROVE/REJECT) against the *last* level's dueAt, not a cumulative
    // deadline across every level a multi-level request passed through -
    // dueAt is recomputed (and any earlier overdue state cleared) each time
    // a request advances a level, by design (see approvals.service.ts).
    let turnaroundHoursSum = 0;
    let compliantCount = 0;
    for (const a of completedApprovals) {
      turnaroundHoursSum += (a.updatedAt.getTime() - a.createdAt.getTime()) / 3_600_000;
      if (!a.dueAt || a.updatedAt.getTime() <= a.dueAt.getTime()) compliantCount += 1;
    }
    const completedCount = completedApprovals.length;

    return {
      cashTrend90d,
      paymentVolumeByMonth,
      avgApprovalTurnaroundHours: completedCount ? turnaroundHoursSum / completedCount : null,
      slaComplianceRate: completedCount ? compliantCount / completedCount : null,
      completedApprovalsCount: completedCount,
      topBeneficiaries: topBeneficiaries.map((b) => ({
        name: b.beneficiaryName,
        account: b.beneficiaryAccount,
        total: Number(b._sum.amount ?? 0),
        count: b._count,
      })),
    };
  },
};

function parseFakeQuery() {
  // Dashboard only needs the pending count + first few rows; reuse the
  // paginated approvals query with a generous page size.
  return { page: 1, pageSize: 50, skip: 0, take: 50, sortDir: "asc" as const };
}

function buildAlerts(position: Awaited<ReturnType<typeof cashPositionService.getSummary>>, staleAccounts: { id: string; accountName: string; lastBalanceAt: Date | null }[]) {
  const alerts: { severity: "critical" | "warning" | "info"; title: string; message: string }[] = [];

  for (const account of position.accounts) {
    if (account.cashStatus === "SHORTFALL") {
      alerts.push({
        severity: "critical",
        title: `${account.accountName} below minimum balance`,
        message: `Shortfall of ${account.shortfall.toLocaleString()} ${account.currencyCode}. A transfer is recommended.`,
      });
    }
  }
  for (const account of position.accounts) {
    if (account.cashStatus === "EXCESS") {
      alerts.push({
        severity: "info",
        title: `${account.accountName} holds excess cash`,
        message: `${account.excessCash.toLocaleString()} ${account.currencyCode} above target balance.`,
      });
    }
  }
  for (const stale of staleAccounts) {
    alerts.push({
      severity: "warning",
      title: `${stale.accountName} balance not updated recently`,
      message: stale.lastBalanceAt ? `Last updated ${stale.lastBalanceAt.toISOString().slice(0, 10)}.` : "No balance recorded yet.",
    });
  }

  return alerts;
}
