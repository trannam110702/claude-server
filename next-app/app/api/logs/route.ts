import { NextRequest, NextResponse } from "next/server";
import { queryLogs } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "50");
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;
    const endpoint = searchParams.get("endpoint") || undefined;

    const result = queryLogs({ page, limit, startDate, endDate, endpoint });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}