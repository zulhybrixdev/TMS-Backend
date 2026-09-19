import { Router, Request, Response } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { requirePermission } from "../../common/middleware/rbac.middleware";
import { requireModule } from "../../common/middleware/plan.middleware";
import { PERMISSIONS } from "../../common/permissions";
import { MODULE_KEYS } from "../../common/plans";
import { CsvColumn } from "../../common/csv";
import { toXlsxBuffer } from "../../common/xlsx";
import {
  reportsService,
  CASH_POSITION_COLUMNS,
  BANK_BALANCES_COLUMNS,
  PAYMENTS_COLUMNS,
  INCOMING_COLUMNS,
  TRANSFERS_COLUMNS,
  FORECAST_COLUMNS,
} from "./reports.service";
import { auditService } from "../../common/audit.service";

export const reportsRouter = Router();
reportsRouter.use(requirePermission(PERMISSIONS.REPORTS_VIEW, PERMISSIONS.REPORTS_EXPORT));
reportsRouter.use(requireModule(MODULE_KEYS.REPORTS_EXPORT));

function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

async function sendXlsx<T>(res: Response, filename: string, sheetName: string, rows: T[], columns: CsvColumn<T>[]) {
  const buffer = await toXlsxBuffer(sheetName, rows, columns);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

function dateRange(req: Request) {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400000);
  return { from, to };
}

// "csv" and "xlsx" are both real export formats worth an audit trail entry
// (someone took data out of the system); on-screen JSON views aren't.
async function auditExport(req: Request, reportName: string) {
  if (req.query.format === "csv" || req.query.format === "xlsx") {
    await auditService.record({ tenantId: req.user!.tenantId, actorId: req.user!.id, action: `report.export.${req.query.format}`, entityType: "Report", entityId: reportName });
  }
}

reportsRouter.get(
  "/cash-position",
  asyncHandler(async (req, res) => {
    const rows = await reportsService.cashPosition(req.user!.tenantId);
    if (req.query.format === "csv") {
      await auditExport(req, "cash-position");
      return sendCsv(res, "cash-position.csv", reportsService.cashPositionCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "cash-position");
      return sendXlsx(res, "cash-position.xlsx", "Cash Position", rows, CASH_POSITION_COLUMNS);
    }
    ok(res, rows);
  })
);

reportsRouter.get(
  "/bank-balances",
  asyncHandler(async (req, res) => {
    const rows = await reportsService.bankBalances(req.user!.tenantId);
    if (req.query.format === "csv") {
      await auditExport(req, "bank-balances");
      return sendCsv(res, "bank-balances.csv", reportsService.bankBalancesCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "bank-balances");
      return sendXlsx(res, "bank-balances.xlsx", "Bank Balances", rows, BANK_BALANCES_COLUMNS);
    }
    ok(res, rows);
  })
);

reportsRouter.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const { from, to } = dateRange(req);
    const rows = await reportsService.payments(req.user!.tenantId, from, to);
    if (req.query.format === "csv") {
      await auditExport(req, "payments");
      return sendCsv(res, "payments.csv", reportsService.paymentsCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "payments");
      return sendXlsx(res, "payments.xlsx", "Payments", rows, PAYMENTS_COLUMNS);
    }
    ok(res, rows);
  })
);

reportsRouter.get(
  "/incoming",
  asyncHandler(async (req, res) => {
    const { from, to } = dateRange(req);
    const rows = await reportsService.incoming(req.user!.tenantId, from, to);
    if (req.query.format === "csv") {
      await auditExport(req, "incoming");
      return sendCsv(res, "incoming.csv", reportsService.incomingCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "incoming");
      return sendXlsx(res, "incoming.xlsx", "Incoming Transactions", rows, INCOMING_COLUMNS);
    }
    ok(res, rows);
  })
);

reportsRouter.get(
  "/transfers",
  asyncHandler(async (req, res) => {
    const { from, to } = dateRange(req);
    const rows = await reportsService.transfers(req.user!.tenantId, from, to);
    if (req.query.format === "csv") {
      await auditExport(req, "transfers");
      return sendCsv(res, "transfers.csv", reportsService.transfersCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "transfers");
      return sendXlsx(res, "transfers.xlsx", "Transfers", rows, TRANSFERS_COLUMNS);
    }
    ok(res, rows);
  })
);

reportsRouter.get(
  "/cash-flow",
  asyncHandler(async (req, res) => {
    const { from, to } = dateRange(req);
    ok(res, await reportsService.cashFlow(req.user!.tenantId, from, to));
  })
);

reportsRouter.get(
  "/forecast",
  asyncHandler(async (req, res) => {
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 86400000);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const rows = await reportsService.forecast(req.user!.tenantId, from, to);
    if (req.query.format === "csv") {
      await auditExport(req, "forecast");
      return sendCsv(res, "forecast.csv", reportsService.forecastCsv(rows));
    }
    if (req.query.format === "xlsx") {
      await auditExport(req, "forecast");
      return sendXlsx(res, "forecast.xlsx", "Forecast", rows, FORECAST_COLUMNS);
    }
    ok(res, rows);
  })
);

// No tenant-facing "/audit" report - the audit trail is overseen
// exclusively via Platform Console, not self-serve inside a tenant's own
// Reports/Administration. reportsService.audit()/auditCsv() are unused by
// this router now but left in place in case platform tooling wants them.
