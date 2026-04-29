import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { consumeCallback } from "@/lib/pendingCallbacks";

/**
 * GET /api/claude/oauth/poll?state=…
 *
 * Returns:
 *   { pending: true }                                  — nothing yet
 *   { code, state }                                    — code captured, ready to exchange
 *   { error, errorDescription }                        — Claude returned an error
 *
 * The matching entry is consumed (deleted) the first time it's read so a
 * second poll won't re-trigger the exchange.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  if (!state) {
    return NextResponse.json({ error: "Missing state" }, { status: 400 });
  }

  const entry = consumeCallback(state);
  if (!entry) return NextResponse.json({ pending: true });

  if (entry.error) {
    return NextResponse.json({
      error: entry.error,
      errorDescription: entry.errorDescription || null,
    });
  }
  return NextResponse.json({
    code: entry.code,
    state: entry.state || state,
  });
}
