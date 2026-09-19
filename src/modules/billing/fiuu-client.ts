import crypto from "crypto";
import { env } from "../../config/env";

// Fiuu (formerly MOLPay/Razer Merchant Services) payment gateway client for
// subscription checkout. Signature scheme ported from the working
// integration in ~/Documents/HD/SyokBill (syokbill-main-service/lib/fiuu-api.ts,
// syokbill-fiuu-service), adapted for a single platform-wide merchant
// account (we bill tenants for their subscription, rather than
// intermediating many merchants' own credentials).
//
// Dummy fallback: when FIUU_MERCHANT_ID/FIUU_VERIFY_KEY are not set (no
// live credentials yet), buildCheckoutUrl() returns an internal
// "/billing/dummy-checkout" link instead of a fiuu.com one. Everything
// downstream - the vcode/skey signing, the notification handler, invoice
// and subscription activation - runs through the exact same code either
// way, so switching to real Fiuu sandbox later is just setting the two env
// vars, no code change.

export interface CheckoutOrder {
  orderId: string;
  amountMYR: number;
  description: string;
  billName: string;
  billEmail: string;
}

export interface CheckoutResult {
  url: string;
  isDummy: boolean;
}

export function isFiuuConfigured(): boolean {
  return Boolean(env.fiuuMerchantId && env.fiuuVerifyKey);
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

// vcode = md5(amount + merchantId + orderId + verifyKey) - the standard
// Fiuu/MOLPay seamless request signature.
export function computeVCode(amountMYR: number, orderId: string, merchantId: string, verifyKey: string): string {
  const data = `${formatAmount(amountMYR)}${merchantId}${orderId}${verifyKey}`;
  return crypto.createHash("md5").update(data).digest("hex");
}

// skey validation for the return/notification callback - double MD5 over
// the transaction fields, keyed with the same verify key.
export function computeSKey(payload: { tranId: string; orderId: string; status: string; domain: string; amountMYR: number; currency: string; appCode: string }, verifyKey: string): string {
  const key0 = crypto
    .createHash("md5")
    .update(`${payload.tranId}${payload.orderId}${payload.status}${payload.domain}${formatAmount(payload.amountMYR)}${payload.currency}`)
    .digest("hex");
  return crypto.createHash("md5").update(`${key0}${payload.appCode}${verifyKey}`).digest("hex");
}

export function verifySKey(payload: { tranId: string; orderId: string; status: string; domain: string; amountMYR: number; currency: string; appCode: string }, skey: string): boolean {
  if (!env.fiuuVerifyKey) return false;
  return computeSKey(payload, env.fiuuVerifyKey) === skey;
}

export function buildCheckoutUrl(order: CheckoutOrder): CheckoutResult {
  if (!isFiuuConfigured()) {
    const params = new URLSearchParams({
      orderId: order.orderId,
      amount: formatAmount(order.amountMYR),
      description: order.description,
    });
    return { url: `${env.appUrl}/billing/dummy-checkout?${params.toString()}`, isDummy: true };
  }

  const merchantId = env.fiuuMerchantId!;
  const verifyKey = env.fiuuVerifyKey!;
  const vcode = computeVCode(order.amountMYR, order.orderId, merchantId, verifyKey);
  const baseUrl = env.fiuuEnvironment === "production" ? "https://pay.fiuu.com" : "https://sandbox-payment.fiuu.com";

  const params = new URLSearchParams({
    MerchantID: merchantId,
    amount: formatAmount(order.amountMYR),
    orderid: order.orderId,
    bill_name: order.billName,
    bill_email: order.billEmail,
    bill_desc: order.description,
    country: "MY",
    currency: "MYR",
    vcode,
    returnurl: `${env.appUrl}/billing/return`,
    notifyurl: `${env.appUrl.replace(/\/$/, "")}/api/billing/fiuu/notification`,
  });

  return { url: `${baseUrl}/RMS/pay/${merchantId}/index.php?${params.toString()}`, isDummy: false };
}
