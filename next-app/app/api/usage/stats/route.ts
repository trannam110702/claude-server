import { NextResponse } from "next/server";
import { getUsageStats, listAccounts, ClaudeAccount } from "@/lib/db";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }

  const stats = getUsageStats(period as "24h" | "7d" | "30d" | "all");

  // Resolve account_id → display name/email so the table can render labels.
  const accounts = (await listAccounts()) as ClaudeAccount[];
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const byAccount = stats.byAccount.map((row: Record<string, unknown>) => {
    const acct = accountById.get(row.account_id as string);
    return {
      ...row,
      account_name: acct?.name ?? null,
      account_email: acct?.email ?? null,
    };
  });

  return NextResponse.json({ ...stats, byAccount });
}
