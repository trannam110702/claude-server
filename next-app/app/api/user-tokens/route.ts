import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createUserToken, listTokensForUser } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tokens = await listTokensForUser(session.user.id);
  return NextResponse.json({ tokens });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const token = await createUserToken({
    userId: session.user.id,
    userEmail: session.user.email || null,
    name: body.name || "",
  });
  return NextResponse.json({ token });
}
