import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok, okPaginated } from "../../common/response";
import { validate } from "../../common/middleware/validate.middleware";
import { authenticatePlatform } from "../../common/middleware/platform-auth.middleware";
import { parseListQuery } from "../../common/pagination";
import { platformConfigService } from "../../common/platform-config.service";
import { platformService } from "./platform.service";
import { keycloakService, createIdpSchema, tenantSsoSchema } from "./keycloak.service";
import { platformLoginSchema, setTenantSubscriptionSchema, setPocModeSchema } from "./platform.schemas";

// Public: platform-admin login only. Everything else requires the
// platform-scoped bearer token (see index.ts route mounting).
export const platformAuthRouter = Router();

platformAuthRouter.post(
  "/login",
  validate(platformLoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    ok(res, await platformService.login(email, password));
  })
);

platformAuthRouter.get(
  "/me",
  authenticatePlatform,
  asyncHandler(async (req, res) => ok(res, await platformService.me(req.platformAdmin!.id)))
);

// Cross-tenant oversight - all routes require authenticatePlatform.
export const platformRouter = Router();
platformRouter.use(authenticatePlatform);

// DB-driven POC/full mode switch - see poc-mode.middleware.ts. Flipping
// this redirects the live site between /poc and the full app within
// seconds, no rebuild or redeploy.
platformRouter.get("/config", asyncHandler(async (_req, res) => ok(res, { pocMode: await platformConfigService.getPocMode() })));
platformRouter.post(
  "/config",
  validate(setPocModeSchema),
  asyncHandler(async (req, res) => ok(res, { pocMode: await platformConfigService.setPocMode(req.body.pocMode) }))
);

platformRouter.get("/tenants", asyncHandler(async (_req, res) => ok(res, await platformService.listTenants())));
platformRouter.get("/tenants/:id", asyncHandler(async (req, res) => ok(res, await platformService.getTenant(req.params.id))));

// Issues a tenant-scoped token (see auth-token.ts) so the platform admin
// can view/act inside this tenant using the normal tenant app - see
// platform.service#impersonateTenant for what that bypasses and why.
// Single sign-on for one tenant: pick/register its identity provider and set
// its SSO options (the same config its own admin sees under Security).
platformRouter.get("/tenants/:id/sso", asyncHandler(async (req, res) => ok(res, await keycloakService.getTenantSso(req.params.id))));
platformRouter.put(
  "/tenants/:id/sso",
  validate(tenantSsoSchema),
  asyncHandler(async (req, res) => ok(res, await keycloakService.setTenantSso(req.platformAdmin!.id, req.params.id, req.body)))
);
platformRouter.delete("/tenants/:id/sso", asyncHandler(async (req, res) => ok(res, await keycloakService.removeTenantSso(req.platformAdmin!.id, req.params.id))));

platformRouter.post("/tenants/:id/impersonate", asyncHandler(async (req, res) => ok(res, await platformService.impersonateTenant(req.platformAdmin!.id, req.params.id))));

platformRouter.post("/tenants/:id/suspend", asyncHandler(async (req, res) => ok(res, await platformService.setStatus(req.platformAdmin!.id, req.params.id, "SUSPENDED"))));
platformRouter.post("/tenants/:id/activate", asyncHandler(async (req, res) => ok(res, await platformService.setStatus(req.platformAdmin!.id, req.params.id, "ACTIVE"))));

platformRouter.post(
  "/tenants/:id/subscription",
  validate(setTenantSubscriptionSchema),
  asyncHandler(async (req, res) => ok(res, await platformService.setSubscription(req.platformAdmin!.id, req.params.id, req.body)))
);

// Combined audit timeline for one tenant - its own users' activity plus
// every platform-admin action taken on it (suspend/activate/subscription
// override/impersonation). This is the "overseer audit log" the tenant's
// own Administration no longer exposes.
platformRouter.get(
  "/tenants/:id/audit-logs",
  asyncHandler(async (req, res) => {
    const query = parseListQuery(req, { defaultSort: "createdAt" });
    const { items, meta } = await platformService.getTenantAuditLog(req.params.id, query);
    okPaginated(res, items, meta);
  })
);

// Identity / SSO: this environment's own Keycloak (each tier has its own
// instance). See keycloak.service.ts.
platformRouter.get("/keycloak", asyncHandler(async (_req, res) => ok(res, await keycloakService.overview())));
platformRouter.get("/keycloak/identity-providers", asyncHandler(async (_req, res) => ok(res, await keycloakService.listIdps())));
platformRouter.post(
  "/keycloak/identity-providers",
  validate(createIdpSchema),
  asyncHandler(async (req, res) => ok(res, await keycloakService.createIdp(req.platformAdmin!.id, req.body)))
);
platformRouter.delete(
  "/keycloak/identity-providers/:alias",
  asyncHandler(async (req, res) => ok(res, await keycloakService.deleteIdp(req.platformAdmin!.id, req.params.alias)))
);
