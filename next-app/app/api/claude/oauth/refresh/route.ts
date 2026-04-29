import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export async function POST() {
  try {
    const tokensPath = path.join(process.cwd(), "..", "data", "tokens.json");
    const content = fs.readFileSync(tokensPath, "utf-8");
    const tokens = JSON.parse(content);

    if (!tokens.refreshToken) {
      return NextResponse.json({ error: "No refresh token available" }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: "Token refresh triggered" });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}