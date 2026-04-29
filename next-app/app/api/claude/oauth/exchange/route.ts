import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { exchangeCode, createAccount, listAccounts, updateAccount, ACCOUNTS_DB_FILE } from "@/lib/db";
// @ts-ignore - JS module
import { fetchClaudeProfile } from "../../../../../../lib/usage.js";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { code?: string; redirectUri?: string; codeVerifier?: string; state?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { code, redirectUri, codeVerifier, state, name } = body;
  if (!code || !redirectUri || !codeVerifier) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode({ code, redirectUri, codeVerifier, state });

    // Best-effort profile lookup so we can store the Claude account's email,
    // organization, and full name; used for a sensible default name and the
    // detail dialog on the accounts page.
    const profile = await fetchClaudeProfile(tokens.accessToken);
    const email: string | null = profile.email || null;
    const displayName: string | null = profile.displayName || null;

    const accountName =
      name?.trim() ||
      email ||
      displayName ||
      profile.fullName ||
      `Claude account ${(await listAccounts()).length + 1}`;

    const account = await createAccount({
      name: accountName,
      email,
      fullName: profile.fullName || null,
      organizationName: profile.organizationName || null,
      organizationId: profile.organizationId || null,
      accountUuid: profile.accountUuid || null,
      plan: "Claude Code",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
    if (!account) {
      console.error("[exchange] createAccount returned null");
      return NextResponse.json({ error: "Failed to persist account" }, { status: 500 });
    }
    const all = await listAccounts();
    console.log(`[exchange] persisted account ${account.id} (${account.name}, email=${email || "n/a"}) into ${ACCOUNTS_DB_FILE}; store now has ${all.length} account(s)`);

    return NextResponse.json({
      success: true,
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
