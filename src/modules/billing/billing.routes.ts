import { Router } from "express";
import { asyncHandler } from "../../common/async-handler";
import { ok } from "../../common/response";
import { ForbiddenError } from "../../common/errors";
import { env } from "../../config/env";
import { billingService } from "./billing.service";
import { verifySKey, isFiuuConfigured } from "./fiuu-client";

// Public routes (no `authenticate` - see index.ts route mounting): Fiuu
// calls these directly, identifying itself only via the signed payload
// (classic-integration field names: tranID/orderid/status/domain/amount/
// currency/appcode/skey).
export const billingRouter = Router();

function isSuccessStatus(status: string): boolean {
  return status === "00";
}

async function processFiuuCallback(body: Record<string, any>) {
  const tranId = String(body.tranID ?? body.tranId ?? "");
  const orderId = String(body.orderid ?? body.orderId ?? "");
  const status = String(body.status ?? "");
  const amountMYR = Number(body.amount ?? 0);
  const skey = String(body.skey ?? "");

  const payload = { tranId, orderId, status, domain: String(body.domain ?? ""), amountMYR, currency: String(body.currency ?? "MYR"), appCode: String(body.appcode ?? "") };

  if (!verifySKey(payload, skey)) {
    return { ok: false as const, error: "Invalid payment signature" };
  }

  const invoice = await billingService.handleGatewayResult({ orderId, tranId, success: isSuccessStatus(status), rawPayload: body });
  return { ok: true as const, invoice };
}

// Server-to-server notification - the reliable source of truth for whether
// payment succeeded.
billingRouter.post(
  "/fiuu/notification",
  asyncHandler(async (req, res) => {
    const result = await processFiuuCallback(req.body);
    if (!result.ok) return res.status(401).send("Invalid signature");
    res.status(200).send("OK");
  })
);

// Browser redirect back from the gateway after checkout - processes the
// same way (idempotent - handleGatewayResult no-ops if already processed)
// then bounces the user back into the app's billing status screen.
billingRouter.post(
  "/fiuu/return",
  asyncHandler(async (req, res) => {
    await processFiuuCallback(req.body).catch(() => null);
    res.redirect(`${env.appUrl.replace(/\/$/, "")}/billing/return?orderId=${encodeURIComponent(String(req.body.orderid ?? req.body.orderId ?? ""))}`);
  })
);

billingRouter.get(
  "/fiuu/return",
  asyncHandler(async (req, res) => {
    await processFiuuCallback(req.query as Record<string, any>).catch(() => null);
    res.redirect(`${env.appUrl.replace(/\/$/, "")}/billing/return?orderId=${encodeURIComponent(String(req.query.orderid ?? req.query.orderId ?? ""))}`);
  })
);

// Dev-only simulator backing the frontend's DummyCheckoutPage. No signature
// needed - it IS the trusted source, not a third party - but it only works
// while no real Fiuu credentials are configured, so it can never be used to
// bypass real payment in a production deployment.
billingRouter.post(
  "/dummy/simulate",
  asyncHandler(async (req, res) => {
    if (isFiuuConfigured()) throw new ForbiddenError("Dummy checkout is disabled once Fiuu credentials are configured");
    const { orderId, outcome } = req.body as { orderId: string; outcome: "success" | "fail" };
    const invoice = await billingService.handleGatewayResult({
      orderId,
      tranId: `DUMMY-${Date.now()}`,
      success: outcome === "success",
      rawPayload: { simulated: true, outcome },
    });
    ok(res, invoice);
  })
);
