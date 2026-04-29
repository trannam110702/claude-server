import { NextRequest, NextResponse } from "next/server";
import { queryLogs, listAccounts, ClaudeAccount } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const page = parseInt(searchParams.get("page") || "1") || 1;
    const limit = parseInt(searchParams.get("limit") || "50") || 50;
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const endpoint = searchParams.get("endpoint") || undefined;

    const result = queryLogs({ page, limit, startDate, endDate, endpoint });

    // Enrich each row with the human-readable account name/email so the UI
    // doesn't have to fetch /api/claude/accounts separately.
    const accounts = (await listAccounts()) as ClaudeAccount[];
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const acct = accountById.get(row.account_id as string);
      return {
        ...row,
        account_name: acct?.name || null,
        account_email: acct?.email || null,
      };
    });

    return NextResponse.json({ ...result, rows });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
