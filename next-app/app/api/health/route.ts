import { NextResponse } from "next/server";
import { readTokens } from "@/lib/tokens";

export async function GET() {
  try {
    const tokens = await readTokens();
    const expiresAt = tokens?.expiresAt ? new Date(tokens.expiresAt) : null;
    const now = new Date();

    let status: "active" | "expiring-soon" | "expired" = "active";
    if (!expiresAt) {
      status = "expired";
    } else {
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (diffHours < 0) {
        status = "expired";
      } else if (diffHours < 24) {
        status = "expiring-soon";
      }
    }

    const nextRefresh = new Date(now.getTime() + 30 * 60 * 1000);

    return NextResponse.json({
      tokenExpiry: expiresAt?.toISOString() || null,
      lastRefresh: tokens?.lastRefresh || null,
      nextRefresh: nextRefresh.toISOString(),
      status,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
