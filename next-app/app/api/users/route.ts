import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listUsers, type DashboardUser } from "@/lib/db";
import { isSeedAdmin, isEnvAdmin } from "@/lib/admin";

/**
 * GET /api/users
 *
 * Admin-only. Returns every recorded dashboard sign-in, sorted by last_login_at
 * desc. Each row carries server-computed `isSeedAdmin` / `isEnvAdmin` flags so
 * the UI can disable toggles for hardcoded admins without re-implementing the
 * allowlist logic on the client.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const rows = listUsers() as DashboardUser[];
  const enriched = rows.map((u) => ({
    ...u,
    isSeedAdmin: isSeedAdmin(u.email),
    isEnvAdmin: isEnvAdmin(u.email),
  }));

  return NextResponse.json({ users: enriched });
}
