import { NextResponse } from "next/server";
import { recordCallback } from "@/lib/pendingCallbacks";

/**
 * Server-side OAuth callback. Claude redirects the user's browser here after
 * authorization; we extract code+state and stash them in an in-memory store
 * keyed by `state`. The dashboard modal polls /api/claude/oauth/poll?state=…
 * to pick the entry up — works across Chrome profiles because the server is
 * the coordination point, not the browser.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || undefined;
  const state = url.searchParams.get("state") || undefined;
  const error = url.searchParams.get("error") || undefined;
  const errorDescription = url.searchParams.get("error_description") || undefined;

  recordCallback({ code, state, error, errorDescription });

  const isError = !!error || !code;
  const title = isError ? "Authorization failed" : "Authorization received";
  const message = isError
    ? errorDescription || error || "No authorization code in the redirect."
    : "You can close this tab and return to the dashboard.";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex; align-items: center; justify-content: center;
        min-height: 100vh; margin: 0; padding: 24px;
        background: Canvas; color: CanvasText;
      }
      .card {
        max-width: 28rem; text-align: center;
        padding: 2rem; border: 1px solid color-mix(in oklab, currentColor 15%, transparent);
        border-radius: 12px;
      }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem 0; }
      p { margin: 0.25rem 0; opacity: 0.8; line-height: 1.5; }
      .err { color: #dc2626; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1${isError ? ' class="err"' : ""}>${title}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
    <script>
      // window.close() works only when this tab was opened via script
      // (the dashboard's "Open in popup" option). When the user pasted the
      // auth URL into another Chrome profile, this tab wasn't script-opened,
      // so the call is a silent no-op — that's a browser security rule.
      setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    status: isError ? 400 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}
