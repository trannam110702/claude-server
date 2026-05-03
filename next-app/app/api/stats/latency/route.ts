import { NextResponse } from "next/server";
import { getLatencyPercentiles } from "@/lib/db";

const VALID_PERIODS = new Set(["24h", "7d"]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "24h";
  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  const data = getLatencyPercentiles(period as "24h" | "7d");
  return NextResponse.json(data);
}
