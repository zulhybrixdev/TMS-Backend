import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";

import { env } from "./config/env";
import { authenticate } from "./common/middleware/auth.middleware";
import { tenantContext } from "./common/middleware/tenant.middleware";
import { pocModeRedirect } from "./common/middleware/poc-mode.middleware";
import { notFoundHandler, errorHandler } from "./common/middleware/error.middleware";
import { syncSystemRolePermissions } from "./common/tenant-provisioning";
import { ok } from "./common/response";

import { authRouter } from "./modules/auth/auth.routes";
import { ssoRouter } from "./modules/auth/sso.routes";
import { ssoConfigRouter } from "./modules/auth/sso-config.routes";
import { securityPolicyRouter } from "./modules/auth/security-policy.routes";
import { billingRouter } from "./modules/billing/billing.routes";
import { subscriptionsRouter } from "./modules/subscriptions/subscriptions.routes";
import { platformAuthRouter, platformRouter } from "./modules/platform/platform.routes";
import { usersRouter } from "./modules/users/users.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { banksRouter } from "./modules/banks/banks.routes";
import { bankAccountsRouter } from "./modules/bank-accounts/bank-accounts.routes";
import { cashPositionRouter } from "./modules/cash-position/cash-position.routes";
import { paymentsRouter } from "./modules/payments/payments.routes";
import { beneficiariesRouter } from "./modules/beneficiaries/beneficiaries.routes";
import { paymentTemplatesRouter } from "./modules/payment-templates/payment-templates.routes";
import { paymentTemplatesService } from "./modules/payment-templates/payment-templates.service";
import { commentsRouter } from "./modules/comments/comments.routes";
import { incomingRouter } from "./modules/incoming/incoming.routes";
import { transfersRouter } from "./modules/transfers/transfers.routes";
import { approvalsRouter, approvalRulesRouter } from "./modules/approvals/approvals.routes";
import { approvalsService } from "./modules/approvals/approvals.service";
import { forecastsRouter } from "./modules/forecasts/forecasts.routes";
import { reportsRouter } from "./modules/reports/reports.routes";
import { reportDefinitionsRouter } from "./modules/report-definitions/report-definitions.routes";
import { systemSettingsRouter } from "./modules/system-settings/system-settings.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { currenciesRouter } from "./modules/currencies/currencies.routes";
import { fxRouter } from "./modules/fx/fx.routes";
import { auditLogsRouter } from "./modules/audit-logs/audit-logs.routes";

const app = express();

// Platform Console is only ever served from dev (:3417, see
// frontend/package.json's build scripts, which strip it out of every
// deployable bundle) but reaches into every other environment's
// /api/platform/* cross-origin - so that origin is allowed everywhere,
// alongside this instance's own env.corsOrigin. One cors() call for the
// whole app, not a path-scoped second one: the `cors` package answers an
// OPTIONS preflight itself and ends the request, so a later path-scoped
// cors() middleware would never even run for those requests.
const PLATFORM_CONSOLE_ORIGIN = "http://localhost:3417";
app.use(helmet());
app.use(cors({ origin: [env.corsOrigin, PLATFORM_CONSOLE_ORIGIN], credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan(env.isProduction ? "combined" : "dev"));

app.get("/health", (_req, res) => ok(res, { status: "ok", time: new Date().toISOString() }));

// Public, unauthenticated - lets the frontend show which tier it's
// running against (DEV/UAT/PROD badge, see EnvironmentBadge.tsx) even on
// pre-login pages. Display-only; never used for access control.
app.get("/api/meta", (_req, res) => ok(res, { tier: env.tierLabel }));

// API documentation (Swagger UI backed by openapi.yaml)
try {
  const openapiDocument = YAML.load(path.join(__dirname, "..", "openapi.yaml"));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));
} catch {
  // openapi.yaml missing in this environment - docs route simply unavailable.
}

// Public: login/register live here, plus the Fiuu (or dummy) payment
// gateway callbacks, which authenticate themselves via a signed payload
// instead of a bearer token. Everything else under /api requires one.
app.use("/api/auth", authRouter);
app.use("/api/auth/sso", ssoRouter);
app.use("/api/billing", billingRouter);

// Platform admin: a separate account type, never a tenant's own User, with
// its own token scope - mounted before the tenant `authenticate` below so
// it's never subject to tenant auth/tenantContext.
app.use("/api/platform/auth", platformAuthRouter);
app.use("/api/platform", platformRouter);

app.use("/api", authenticate, tenantContext);

app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/users", usersRouter);
app.use("/api/roles", rolesRouter);
app.use("/api/banks", banksRouter);
app.use("/api/bank-accounts", bankAccountsRouter);
app.use("/api/cash-position", cashPositionRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/beneficiaries", beneficiariesRouter);
app.use("/api/payment-templates", paymentTemplatesRouter);
app.use("/api/comments", commentsRouter);
app.use("/api/incoming-transactions", incomingRouter);
app.use("/api/transfers", transfersRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/approval-rules", approvalRulesRouter);
app.use("/api/forecasts", forecastsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/report-definitions", reportDefinitionsRouter);
// Self-serve tenant audit trail - Pro+ exclusive (see audit-logs.routes.ts
// for how this differs from, and coexists with, the Platform Console's own
// cross-tenant oversight in modules/platform/, which stays unconditional).
app.use("/api/audit-logs", auditLogsRouter);
app.use("/api/system-settings", systemSettingsRouter);
app.use("/api/sso-config", ssoConfigRouter);
app.use("/api/security-policy", securityPolicyRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/currencies", currenciesRouter);
app.use("/api/fx", fxRouter);

// Serves the frontend build(s) from this one port. /platform is always
// reachable, on every tier (uat and production alike) - see index route
// registrations above, mounted before this block.
const pocDist = path.join(__dirname, "..", "..", "frontend", "dist-poc");
const fullDist = path.join(__dirname, "..", "..", "frontend", "dist");

if (env.deployEnv === "production") {
  // Production never mounts /poc or the redirect at all - not disabled,
  // structurally absent - so real clients can never land on the POC build
  // no matter what PlatformConfig.pocMode says (that flag only governs the
  // uat tier). "/poc" here just falls through to the full app's own
  // client-side router, which shows its normal not-found page.
  app.use(express.static(fullDist));
  app.get(/^(?!\/api).*/, (_req, res, next) => res.sendFile(path.join(fullDist, "index.html"), (err) => err && next()));
} else {
  // uat tier: both builds present, switchable live via the DB flag
  // (PlatformConfig.pocMode, toggled from Platform Console) - runs before
  // the static handlers so it can redirect before either build is served.
  app.use(pocModeRedirect);

  app.use("/poc", express.static(pocDist));
  app.get(/^\/poc(\/.*)?$/, (_req, res, next) => res.sendFile(path.join(pocDist, "index.html"), (err) => err && next()));

  app.use(express.static(fullDist));
  app.get(/^(?!\/api|\/poc).*/, (_req, res, next) => res.sendFile(path.join(fullDist, "index.html"), (err) => err && next()));
}

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[tms-backend] listening on port ${env.port} (${env.nodeEnv})`);
  // eslint-disable-next-line no-console
  console.log(`[tms-backend] API docs: http://localhost:${env.port}/api/docs`);
});

// One-time catch-up at boot: grants any permission added to
// DEFAULT_ROLE_PERMISSIONS since a tenant was provisioned to that tenant's
// system roles (see tenant-provisioning.ts's syncSystemRolePermissions for
// why this couldn't happen any other way). Cheap and idempotent - safe to
// run on every restart, not just the first one after a permissions change.
syncSystemRolePermissions()
  .then(({ tenantsChecked, permissionsGranted }) => {
    if (permissionsGranted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[tms-backend] system role permission sync: granted ${permissionsGranted} missing permission(s) across ${tenantsChecked} tenant(s)`);
    }
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[tms-backend] system role permission sync failed:", err);
  });

// Approval SLA sweep: notifies current-level approvers again for any
// PENDING request still un-actioned past its dueAt. Single-instance-only
// (fine for every tier here - one backend process per tier under pm2, see
// ecosystem.config.cjs); a horizontally-scaled deployment would need to
// move this to a real job queue instead of an in-process interval.
setInterval(() => {
  approvalsService.checkEscalations().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[tms-backend] approval SLA sweep failed:", err);
  });
}, 15 * 60 * 1000);

// Recurring payment template sweep - same single-instance caveat as the
// SLA sweep above. Hourly is plenty for WEEKLY/MONTHLY schedules; a
// template is only ever late by less than this interval.
setInterval(() => {
  paymentTemplatesService.runScheduledTemplates().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[tms-backend] payment template sweep failed:", err);
  });
}, 60 * 60 * 1000);

export default app;
