import { NextResponse } from "next/server";
import { readTokens } from "@/lib/tokens";

export async function GET() {
  try {
    const tokens = await readTokens();
    if (!tokens) {
      return NextResponse.json({ connected: false });
    }
    return NextResponse.json({
      connected: true,
      expiresAt: tokens.expiresAt,
      hasRefreshToken: !!tokens.refreshToken,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
