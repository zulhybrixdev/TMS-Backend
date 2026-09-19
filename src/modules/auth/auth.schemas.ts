import { z } from "zod";
import { PLAN_KEYS } from "../../common/plans";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export const mfaVerifySchema = z.object({
  code: z.string().min(6, "Enter the 6-digit code from your authenticator app").max(8),
});

export const mfaDisableSchema = z.object({
  password: z.string().min(1),
});

export const mfaChallengeSchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(6).max(11), // 6-digit TOTP, or an XXXXX-XXXXX recovery code
});

export const registerSchema = z.object({
  companyName: z.string().min(2, "Company/organisation name is required"),
  accountType: z.enum(["INDIVIDUAL", "TEAM", "ENTERPRISE"]),
  planKey: z.enum([PLAN_KEYS.FREE, PLAN_KEYS.PRO, PLAN_KEYS.PRO_PLUS]),
  name: z.string().min(1, "Your name is required"),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  jobTitle: z.string().optional(),
});
