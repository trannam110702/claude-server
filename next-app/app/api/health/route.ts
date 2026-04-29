import { NextResponse } from "next/server";
import { listAccounts, ClaudeAccount } from "@/lib/db";

export async function GET() {
  const accounts = (await listAccounts()) as ClaudeAccount[];
  const active = accounts.filter((a) => a.isActive);

  // Soonest-expiring active account drives the dashboard status badge.
  const soonest = active
    .filter((a) => a.expiresAt)
    .sort((a, b) => +new Date(a.expiresAt!) - +new Date(b.expiresAt!))[0];

  let status: "active" | "expiring-soon" | "expired" = "active";
  if (active.length === 0) {
    status = "expired";
  } else if (soonest) {
    const diffHours = (new Date(soonest.expiresAt!).getTime() - Date.now()) / (1000 * 60 * 60);
    if (diffHours < 0) status = "expired";
    else if (diffHours < 24) status = "expiring-soon";
  }

  const lastRefresh = active
    .map((a) => a.updatedAt)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null;

  return NextResponse.json({
    tokenExpiry: soonest?.expiresAt || null,
    lastRefresh,
    nextRefresh: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    status,
    accountCount: accounts.length,
    activeCount: active.length,
  });
}
