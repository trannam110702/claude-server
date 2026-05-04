import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { setAdminInDb } from "@/lib/db";
import { isSeedAdmin, isEnvAdmin } from "@/lib/admin";

/**
 * PATCH /api/users/[email]
 *
 * Admin-only. Body: { isAdmin: boolean }. Email is lowercased before lookup.
 * Refuses to mutate seed/env admins (toggle is a no-op for those rows since
 * their admin status comes from elsewhere — fail loudly so the operator sees
 * what's happening instead of a silently-ignored write).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail).toLowerCase();

  let body: { isAdmin?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.isAdmin !== "boolean") {
    return NextResponse.json({ error: "isAdmin must be a boolean" }, { status: 400 });
  }

  if (isSeedAdmin(email) || isEnvAdmin(email)) {
    return NextResponse.json(
      {
        error:
          "Cannot modify hardcoded admin. Edit lib/admin.ts (seed) or ADMIN_EMAILS env var instead.",
      },
      { status: 400 }
    );
  }

  const ok = setAdminInDb(email, body.isAdmin);
  if (!ok) {
    return NextResponse.json(
      { error: "User not found. They must sign in at least once before being promoted." },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, email, isAdmin: body.isAdmin });
}
