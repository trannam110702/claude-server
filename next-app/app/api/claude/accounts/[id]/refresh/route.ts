import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAccount, updateAccount, refreshAccessToken } from "@/lib/db";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const { id } = await params;
  const account = await getAccount(id);
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!account.refreshToken) {
    return NextResponse.json({ error: "No refresh token on this account" }, { status: 400 });
  }

  try {
    const fresh = await refreshAccessToken(account.refreshToken);
    const updated = await updateAccount(id, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      lastError: null,
      lastErrorAt: null,
    });
    return NextResponse.json({
      success: true,
      account: { id, expiresAt: updated?.expiresAt ?? null },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
