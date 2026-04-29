import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listAccounts, updateAccount, refreshAccessToken, ClaudeAccount } from "@/lib/db";

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const all = (await listAccounts()) as ClaudeAccount[];
  const accounts = all.filter((a) => a.isActive && a.refreshToken);
  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const account of accounts) {
    try {
      const fresh = await refreshAccessToken(account.refreshToken!);
      await updateAccount(account.id, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        lastError: null,
        lastErrorAt: null,
      });
      results.push({ id: account.id, ok: true });
    } catch (err) {
      results.push({ id: account.id, ok: false, error: (err as Error).message });
    }
  }

  return NextResponse.json({ success: true, refreshed: results.length, results });
}
