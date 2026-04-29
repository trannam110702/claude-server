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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}