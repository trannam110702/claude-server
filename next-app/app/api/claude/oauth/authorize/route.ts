import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateAuthData } from "@/lib/db";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const redirectUri = searchParams.get("redirect_uri");
  if (!redirectUri) {
    return NextResponse.json({ error: "Missing redirect_uri" }, { status: 400 });
  }

  const data = generateAuthData(redirectUri);
  return NextResponse.json(data);
}
