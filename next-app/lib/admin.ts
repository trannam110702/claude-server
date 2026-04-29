/**
 * Admin email allowlist. The seed admin is namtlv@avadagroup.com; extend by
 * setting the ADMIN_EMAILS env var (comma-separated) — its values are
 * concatenated with the seed list.
 */
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

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}
