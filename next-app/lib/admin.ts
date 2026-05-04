/**
 * Admin email allowlist. The seed admin is namtlv@avadagroup.com; extend by
 * setting the ADMIN_EMAILS env var (comma-separated) — its values are
 * concatenated with the seed list. Plus, after Task 4, the DB users.is_admin
 * flag is unioned in: any of the three sources can grant admin.
 */
import { isAdminInDb } from "./db";

const SEED_ADMINS = ["namtlv@avadagroup.com"];

function fromEnv() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function getAdminEmails(): string[] {
  const set = new Set<string>([...SEED_ADMINS.map((e) => e.toLowerCase()), ...fromEnv()]);
  return Array.from(set);
}

/** True if email is in the hardcoded seed list. */
export function isSeedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return SEED_ADMINS.map((e) => e.toLowerCase()).includes(email.toLowerCase());
}

/** True if email is in the ADMIN_EMAILS env var (excluding the seed list). */
export function isEnvAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return fromEnv().includes(email.toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (isSeedAdmin(e) || isEnvAdmin(e)) return true;
  try {
    return isAdminInDb(e);
  } catch (err) {
    // DB is best-effort here; if it fails, fall back to seed/env only so we
    // never lock anyone out due to a DB hiccup.
    console.error("[admin] isAdminInDb threw:", (err as Error).message);
    return false;
  }
}
