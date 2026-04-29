import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAccount, ensureFreshAccount, refreshAccessToken, updateAccount } from "@/lib/db";
// @ts-ignore - JS module
import { fetchClaudeUsage } from "../../../../../../../lib/usage.js";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let account = await getAccount(id);
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ensure the access token is fresh before hitting Anthropic.
  try {
    const fresh = await ensureFreshAccount(account);
    if (fresh) account = fresh;
  } catch (err) {
    return NextResponse.json(
      { error: `Token refresh failed: ${(err as Error).message}` },
      { status: 401 }
    );
  }
  if (!account) {
    return NextResponse.json({ error: "Account vanished during refresh" }, { status: 404 });
  }

  let usage = await fetchClaudeUsage(account.accessToken);

  // If the OAuth endpoint says we're unauthorized, force-refresh and retry once.
  if ("status" in usage && usage.status === 401 && account.refreshToken) {
    try {
      const fresh = await refreshAccessToken(account.refreshToken);
      const updated = await updateAccount(account.id, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        lastError: null,
        lastErrorAt: null,
      });
      if (updated) usage = await fetchClaudeUsage(updated.accessToken);
    } catch {}
  }

  return NextResponse.json(usage);
}
