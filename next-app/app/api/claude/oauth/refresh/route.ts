import { NextResponse } from "next/server";
import { readTokens } from "@/lib/tokens";

export async function POST() {
  try {
    const tokens = await readTokens();

    if (!tokens?.refreshToken) {
      return NextResponse.json({ error: "No refresh token available" }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: "Token refresh triggered" });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
