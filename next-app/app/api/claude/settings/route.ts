import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSettings, updateSettings } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await getSettings();
  return NextResponse.json({
    settings,
    isAdmin: !!session.user.isAdmin,
  });
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  let body: { roundRobin?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const settings = await updateSettings(body);
  return NextResponse.json({ settings });
}
