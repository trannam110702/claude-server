import { NextResponse } from "next/server";
import { queryLeaderboard } from "@/lib/db";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "all"]);
const VALID_SORTS = new Set(["total_tokens", "requests"]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  const sort = searchParams.get("sort") || "total_tokens";

  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json({ error: "Invalid sort" }, { status: 400 });
  }

  const rows = queryLeaderboard(
    period as "24h" | "7d" | "30d" | "all",
    sort as "total_tokens" | "requests"
  );

  return NextResponse.json({ period, sort, rows });
}
