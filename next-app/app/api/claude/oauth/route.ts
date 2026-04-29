import { NextResponse } from "next/server";
import { listAccounts, ClaudeAccount } from "@/lib/db";

export async function GET() {
  const accounts = (await listAccounts()) as ClaudeAccount[];
  const active = accounts.filter((a) => a.isActive);
  return NextResponse.json({
    connected: active.length > 0,
    accountCount: accounts.length,
    activeCount: active.length,
  });
}
