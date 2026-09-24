// Common Service: current version of each legal document a person must accept
// when registering. The version is a date (YYYY-MM-DD, the day the text was
// last changed). Bump it whenever the Terms or Privacy Policy change in a way
// that matters - the registration form sends the version the person actually
// saw, and the server refuses a stale one, so nobody can accept text that has
// since been replaced.
//
// Keep in step with TMS-Frontend/src/lib/legal-content.ts (LEGAL_VERSIONS).
export const LEGAL_VERSIONS = {
  terms: "2026-09-24",
  privacy: "2026-09-24",
} as const;
