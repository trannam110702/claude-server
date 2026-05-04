import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listUsers, inviteUser, type DashboardUser } from "@/lib/db";
import { isSeedAdmin, isEnvAdmin } from "@/lib/admin";

// RFC-5322-lite — close enough to catch typos without rejecting valid edge
// cases. We're not the OAuth provider; Google does the real validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/**
 * POST /api/users
 *
 * Admin-only. Pre-authorize a user before they've signed in via Google.
 * Body: { email: string, isAdmin?: boolean (default true) }.
 * - 409 if the email already has a row (use PATCH to toggle their admin flag).
 * - 400 if the email is in the seed/env allowlist (already admin — no-op).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  let body: { email?: string; isAdmin?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  if (isSeedAdmin(email) || isEnvAdmin(email)) {
    return NextResponse.json(
      {
        error:
          "This email is already admin via the hardcoded seed list or ADMIN_EMAILS env var. No need to add a row.",
      },
      { status: 400 }
    );
  }

  const isAdminFlag = body.isAdmin !== false; // default true
  const result = inviteUser({ email, isAdmin: isAdminFlag }) as { created: boolean };
  if (!result.created) {
    return NextResponse.json(
      { error: "User already exists. Use the Admin toggle to change their role." },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true, email, isAdmin: isAdminFlag }, { status: 201 });
}
