import crypto from "crypto";
import { env } from "../config/env";

// Encrypts a user's TOTP secret at rest (User.totpSecret) - a leaked
// database dump shouldn't hand out working MFA bypass codes. Recovery
// codes are hashed (bcrypt, one-way) instead of encrypted since they're
// single-use and never need to be read back; a TOTP secret has to be
// decrypted on every login to verify the code, so it needs reversible
// encryption instead.
const KEY = crypto.createHash("sha256").update(env.mfaEncryptionKey).digest();
const ALGORITHM = "aes-256-gcm";

export function encryptTotpSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptTotpSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
