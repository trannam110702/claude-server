import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json({ baseUrl: resolveProxyBaseUrl(request) });
}

function resolveProxyBaseUrl(req: Request): string {
  const override = process.env.PUBLIC_PROXY_URL;
  if (override) return override.replace(/\/+$/, "");

  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const proto = h.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}
