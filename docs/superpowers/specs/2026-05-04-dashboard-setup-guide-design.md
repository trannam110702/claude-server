# Dashboard Setup Guide — Design

Date: 2026-05-04
Status: Approved (pending user review of this document)

## Goal

Help users who got an API token from this dashboard wire it into Claude Code in under a minute, without leaving the dashboard. The token is meant to be set as `ANTHROPIC_AUTH_TOKEN` in Claude Code's `settings.json`, with `ANTHROPIC_BASE_URL` pointed at this proxy.

Audience: end users of the proxy (Claude Code consumers). Not operators / self-hosters — that path is already covered by the repo `README.md`.

## Outcome

- A new dashboard page at `/dashboard/docs` ("Setup guide") with a complete walkthrough.
- A compact inline section on `/dashboard/tokens` with the same auto-filled snippet, so token creation and wiring happen in one screen.
- Both surfaces share a single component for the snippet block, so they cannot drift.
- No new backend, no new API routes, no schema changes.

## Decisions (with chosen options)

1. **Surface placement (C):** inline snippet on the tokens page **plus** a dedicated `/dashboard/docs` page. The inline card is the 30-second path; the docs page is the 5-minute path.
2. **Snippet content (D):** auto-filled `settings.json` snippet **plus** a verification step (`curl /health` + a sample command).
3. **Token in snippet (C):** if the user has ≥1 active token, default to the most recently created one (masked, with reveal toggle); if they have none, show a `<YOUR_API_TOKEN>` placeholder and a "Create token" CTA.
4. **Base URL (A):** read `window.location.origin` on the client. Works correctly for IP, domain, and SSH-tunnel access because Express on `:8080` reverse-proxies the dashboard, so users always hit the dashboard and the proxy API on the same origin (see `index.js:106-114`).
5. **Content sections (B — Standard):** Quickstart snippet, "Where is settings.json?", Verify, Troubleshooting. Other clients (OpenAI SDK, Cursor, etc.) and raw `curl` examples are explicitly out of scope for v1.

## Architecture

Single client-rendered page. Re-uses the existing `GET /api/user-tokens` endpoint that the tokens page already consumes. No server component, no new API.

```
/dashboard/docs/page.tsx (client)
  ├── fetches /api/user-tokens on mount
  ├── reads window.location.origin on mount
  ├── renders sections 1-5
  └── uses <SnippetBlock> for every code block

/dashboard/tokens/page.tsx (existing, modified)
  ├── adds an inline "Use this token in Claude Code" card
  └── uses the same <SnippetBlock> with a subset of content

components/SnippetBlock.tsx (new, shared)
  └── encapsulates: pre/code rendering + copy-with-feedback button

lib/tokens-ui.ts (new, shared)
  ├── maskedSecret(secret)         — moved from tokens/page.tsx
  └── UserToken interface          — moved from tokens/page.tsx
```

## Page layout — `/dashboard/docs`

One column, capped at `max-w-3xl`. Sections from top to bottom:

### Header
- `h1`: "Setup guide"
- Subtitle: "Point Claude Code at this proxy in under a minute."

### Section 1 — Pick a token (Card)
Three states based on the `/api/user-tokens` fetch:
- **Loading:** "Loading…"
- **Empty (no tokens or all revoked):** Short message + "Create a token" button linking to `/dashboard/tokens`. Subsequent snippet uses `<YOUR_API_TOKEN>` placeholder.
- **Has tokens:** A shadcn `<Select>` listing tokens by name. Default selection: most recently created active token. Below it, the chosen token rendered with the existing mask pattern (`cs_xxxxxxxx••••••••`), with eye-toggle reveal and a copy button — same controls used on the tokens page.

### Section 2 — Add to Claude Code's `settings.json` (Card)

Code block (rendered via `<SnippetBlock language="json">`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<window.location.origin>",
    "ANTHROPIC_AUTH_TOKEN": "<selected token or placeholder>"
  }
}
```

Trailing note (one line): "If you're viewing this through an SSH tunnel, replace the host with the server's public address before copying."

### Section 3 — Where is `settings.json`? (Card)
Three rows, no tabs:
- **User-level (recommended):** `~/.claude/settings.json` (macOS / Linux) · `%USERPROFILE%\.claude\settings.json` (Windows)
- **Project-level:** `.claude/settings.json` in the repo root — overrides user-level for that project
- **Note:** "Create the file if it doesn't exist. Merge the `env` block with anything already in the file."

### Section 4 — Verify it works (Card)
Two stacked code blocks:
1. `curl <origin>/health` — describe expected response (the existing endpoint returns JSON; exact shape to be confirmed during implementation by reading `index.js` / proxy code).
2. A minimal Claude Code invocation against the configured env, e.g. `claude "say hello"`. If no canonical one-liner exists, fall back to a short `curl` against `/v1/messages` with a one-message body.

Both blocks are `<SnippetBlock>`s with their own copy button. `<origin>` is auto-filled the same way as Section 2.

### Section 5 — Troubleshooting (Card)
Definition list with four entries:
- **`401 Unauthorized`** → token wrong or revoked; check `/dashboard/tokens`.
- **`Cannot connect` / `ECONNREFUSED`** → `ANTHROPIC_BASE_URL` host unreachable from where Claude Code is running (firewall, tunnel, wrong IP).
- **Works locally, fails from another machine** → likely using `localhost` from a tunnel; switch to the server's public address.
- **Upstream `5xx` from Claude** → check `/dashboard/health` for account status; the proxy may need an upstream token refresh.

## Inline section on `/dashboard/tokens`

A new `<Card>` titled **"Use this token in Claude Code"**, placed between the existing page header and the "Generate a new token" card.

Content:
- One short paragraph: "Add the following to `~/.claude/settings.json`. Claude Code will route requests through this proxy."
- A `<SnippetBlock>` with the same JSON shape as the docs page, auto-filled identically.
- If multiple tokens exist, a small `<Select>` to switch which one is shown. Default = most recently created active token.
- If no tokens exist, snippet uses `<YOUR_API_TOKEN>` placeholder and a one-liner: "Generate a token below to fill this in."
- Trailing `<Link>`: "Need help finding `settings.json` or troubleshooting? **Open the full setup guide →**" → `/dashboard/docs`.

Explicitly **not** in the inline section: settings.json paths, verify steps, troubleshooting. Those live only on the docs page.

## Sidebar

Add one entry to `next-app/app/dashboard/components/Sidebar.tsx`:

```ts
{ href: "/dashboard/docs", label: "Setup guide", icon: BookOpen }
```

Final position in the nav: between "API tokens" and "Usage". Icon: `BookOpen` from lucide-react. Label and icon are not load-bearing — confirm during implementation if there's a stronger choice in lucide.

## Data flow & state (docs page)

```ts
const [origin, setOrigin] = useState("");
const [tokens, setTokens] = useState<UserToken[] | null>(null);
const [selectedId, setSelectedId] = useState<string | null>(null);
const [revealed, setRevealed] = useState(false);
```

Effects:
- On mount: `setOrigin(window.location.origin)` and `fetch("/api/user-tokens")`.
- When tokens arrive: pick the most recently created active token and set `selectedId`. (The existing API appears to return tokens in created-desc order; if not, sort client-side by `createdAt` desc.)

Derived values:
- `selectedToken = tokens?.find(t => t.id === selectedId) ?? null`
- `tokenForSnippet = selectedToken?.secret ?? "<YOUR_API_TOKEN>"`
- `baseUrlForSnippet = origin || "<YOUR_PROXY_URL>"` (placeholder before hydration)
- `snippet = JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrlForSnippet, ANTHROPIC_AUTH_TOKEN: tokenForSnippet } }, null, 2)`

The same logic is reused on the inline tokens-page card (different page, identical derivation). No shared hook is introduced for this v1; if a third surface is added later, extract to `useSnippet()`.

## Edge cases

- **SSR / pre-hydration flash:** during the first server render `origin === ""` and `tokens === null`. Render the snippet block in a placeholder state and let it hydrate. Do not attempt to read `window.location` at SSR time.
- **All tokens revoked:** treated as the empty case — placeholder + CTA.
- **Selected token revoked while page is open:** not handled in v1; the user reloads. Acceptable because revocation is rare and the snippet would visibly contain a no-longer-active token in the dashboard.
- **Tunnel / `localhost` access:** snippet shows `localhost` and the trailing note in Section 2 explains how to fix it. We do not try to detect tunneling automatically.

## File boundaries

**New files:**
- `next-app/app/dashboard/docs/page.tsx` — the docs page (client component).
- `next-app/app/dashboard/components/SnippetBlock.tsx` — reusable code block + copy button.
- `next-app/lib/tokens-ui.ts` — shared `UserToken` type and `maskedSecret()` helper, both moved out of `tokens/page.tsx`.

**Modified files:**
- `next-app/app/dashboard/tokens/page.tsx` — add the inline "Use this token in Claude Code" card; switch to importing `UserToken` and `maskedSecret` from `lib/tokens-ui.ts`; switch its existing code-block copy logic to `<SnippetBlock>` (small refactor, kept in scope because it's the same pattern and prevents drift).
- `next-app/app/dashboard/components/Sidebar.tsx` — add the new nav item.

**Untouched:** Express server (`index.js`), proxy logic (`lib/proxy.js`), API routes, database schema, auth.

## Out of scope (deliberate)

- Other clients (Cursor, Cline, Aider, OpenCode) — Claude Code only for v1.
- OpenAI SDK examples and raw `curl` examples for `/v1/messages` and `/v1/chat/completions` — would expand the page significantly and the audience is users who picked Claude Code.
- Auto-detecting tunnel / `localhost` access and warning more aggressively.
- Live token-revocation feedback on the docs page.
- Internationalization.

## Testing

No new automated tests — this is a content/UI page. Manual smoke checks during implementation:
- Empty state (revoke all tokens, load docs page): placeholder + CTA renders.
- Populated state with one and multiple tokens: selector behaves; snippet updates on change.
- Copy button writes the snippet with the correct origin + token to clipboard.
- Access dashboard via IP, via domain, and via SSH tunnel: snippet reflects the URL the user actually used; tunnel note is visible.
- Sidebar entry shows active state on `/dashboard/docs`.
- Inline card on `/dashboard/tokens` shows the same snippet for the same selected token as the docs page.

## Risks & mitigations

- **Risk:** Snippet logic drifts between the two surfaces. **Mitigation:** both consume the same `<SnippetBlock>` component and derive the snippet string from the same shape; keep it small and don't add per-surface variants.
- **Risk:** Auto-displaying real token secrets on a docs page lowers the visibility bar compared to the tokens page. **Mitigation:** masked-by-default with the same eye-toggle reveal pattern the tokens page already uses; we are not introducing a new disclosure surface, just re-using one.
- **Risk:** `window.location.origin` is wrong when the user accesses through a tunnel. **Mitigation:** explicit one-line note in Section 2 calling out the tunnel case; not silently masked.
