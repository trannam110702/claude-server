import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

function readTokens() {
  const tokensPath = path.join(process.cwd(), "..", "data", "tokens.json");
  try {
    const content = fs.readFileSync(tokensPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const tokens = readTokens();
    if (!tokens) {
      return NextResponse.json({ connected: false });
    }
    return NextResponse.json({
      connected: true,
      expiresAt: tokens.expiresAt,
      hasRefreshToken: !!tokens.refreshToken,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}