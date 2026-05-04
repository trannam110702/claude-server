# Dashboard Setup Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/dashboard/docs` setup-guide page plus a compact inline section on `/dashboard/tokens`, both auto-filling Claude Code's `settings.json` with the user's actual proxy URL and a chosen token.

**Architecture:** A single client-rendered page that reads `window.location.origin` and reuses the existing `GET /api/user-tokens` endpoint to populate a `settings.json` snippet. A new shared `SnippetBlock` component handles code-block rendering + copy-to-clipboard for both the docs page and the inline tokens-page card. No backend, schema, or API changes.

**Tech Stack:** Next.js 15 (App Router) client components, shadcn/ui (Card, Select, Button), lucide-react icons, Tailwind. TypeScript throughout.

---

## File Structure

**New files:**
- `next-app/app/dashboard/docs/page.tsx` — the setup-guide page (client component).
- `next-app/app/dashboard/components/SnippetBlock.tsx` — shared code-block + copy button.

**Modified files:**
- `next-app/lib/utils.ts` — add `maskedSecret(secret)` helper (moved out of `tokens/page.tsx`).
- `next-app/app/dashboard/tokens/page.tsx` — drop the local `UserToken` interface and `maskedSecret`; import them from shared modules; add the inline "Use this token in Claude Code" card above "Generate a new token".
- `next-app/app/dashboard/components/Sidebar.tsx` — add the `Setup guide` nav entry.

**Deviations from the spec:**
- The spec said to switch the existing code-block copy logic in `tokens/page.tsx` to `<SnippetBlock>`. There is no code-block on that page today — only per-row token-cell copy buttons in the tokens `<Table>`. Those stay as-is; `<SnippetBlock>` is used only for the new inline card and the docs page.
- The spec proposed a new `lib/tokens-ui.ts`. Since `next-app/lib/db.ts` already exports a `UserToken` interface and `next-app/lib/utils.ts` already exists for shared helpers, we put `maskedSecret` in `utils.ts` and import `UserToken` from `@/lib/db`. No new utility file.

**Untouched:** Express server (`index.js`), proxy logic (`lib/proxy.js`), API routes, database schema, auth.

---

## Task 1: Extract `maskedSecret` and reuse the shared `UserToken` type

Move the masking helper out of the tokens page so the docs page (and the new inline card) can reuse it. Switch the tokens page from its locally-redefined `UserToken` to the canonical one in `@/lib/db`.

**Files:**
- Modify: `next-app/lib/utils.ts` (add `maskedSecret`)
- Modify: `next-app/app/dashboard/tokens/page.tsx` (remove local `UserToken` and `maskedSecret`; import from shared modules)

- [ ] **Step 1: Add `maskedSecret` to `next-app/lib/utils.ts`**

Append to `next-app/lib/utils.ts`:

```ts
// cs_xxxxxxxxxxxxxxxxxxxxxxxx -> cs_xxxxxxxx•••••••• (preserve prefix, mask rest)
export function maskedSecret(secret: string): string {
  if (!secret) return "";
  const head = secret.slice(0, 11);
  return `${head}${"•".repeat(Math.max(8, Math.min(24, secret.length - 11)))}`;
}
```

Final file contents:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// cs_xxxxxxxxxxxxxxxxxxxxxxxx -> cs_xxxxxxxx•••••••• (preserve prefix, mask rest)
export function maskedSecret(secret: string): string {
  if (!secret) return "";
  const head = secret.slice(0, 11);
  return `${head}${"•".repeat(Math.max(8, Math.min(24, secret.length - 11)))}`;
}
```

- [ ] **Step 2: Update `next-app/app/dashboard/tokens/page.tsx` imports**

In `next-app/app/dashboard/tokens/page.tsx`:

Replace the existing local interface and helper (lines 19-26 and 40-45 in the current file) by removing them entirely, and add an import.

- Delete lines 19–26 (the local `interface UserToken { ... }`).
- Delete lines 40–45 (the local `function maskedSecret(...) { ... }`).
- Add to the top of the file (with the other imports):

```ts
import { maskedSecret } from "@/lib/utils";
import type { UserToken } from "@/lib/db";
```

The rest of the file is unchanged. The `UserToken` from `@/lib/db` is a superset of the local interface (it adds `userId` and `userEmail`), and the API response already returns those fields, so all existing code keeps compiling.

- [ ] **Step 3: Verify TypeScript compiles**

Run from the repo root:

```bash
npm -w next-app run build
```

Expected: build completes with no TypeScript errors. If it fails on the tokens page, inspect the error — most likely a missed deletion of the old local definition.

- [ ] **Step 4: Manual smoke check — tokens page still works**

Run the dev servers:

```bash
npm run dev
```

Open `http://localhost:3000/dashboard/tokens` (or whatever port your `.env` sets). Verify:
- Existing tokens render with the masked display (`cs_xxxxxxxx••••••••`).
- Eye toggle reveals the full token; copy button still copies.
- "Generate token" still works.

If any of the above breaks, the import paths or deleted lines are likely off.

- [ ] **Step 5: Commit**

```bash
git add next-app/lib/utils.ts next-app/app/dashboard/tokens/page.tsx
git commit -m "refactor(dashboard): hoist maskedSecret to lib/utils, reuse UserToken from lib/db"
```

---

## Task 2: Create `SnippetBlock` shared component

A small client component used by every code block on the docs page and the inline tokens-page card. Owns its own "just copied" tick state.

**Files:**
- Create: `next-app/app/dashboard/components/SnippetBlock.tsx`

- [ ] **Step 1: Create the component**

Create `next-app/app/dashboard/components/SnippetBlock.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  code: string;
  language?: "json" | "bash";
  className?: string;
};

export function SnippetBlock({ code, language = "bash", className }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in non-secure contexts; silently ignore.
    }
  };

  return (
    <div className={cn("relative", className)}>
      <pre
        className="overflow-x-auto rounded-md border bg-muted p-4 pr-12 text-xs leading-relaxed"
        data-language={language}
      >
        <code className="font-mono">{code}</code>
      </pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute right-2 top-2 h-7 w-7"
        onClick={onCopy}
        aria-label="Copy snippet"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm -w next-app run build
```

Expected: build completes with no errors. The component is not imported anywhere yet, so the build passes only if the file itself has no type errors.

- [ ] **Step 3: Commit**

```bash
git add next-app/app/dashboard/components/SnippetBlock.tsx
git commit -m "feat(dashboard): add shared SnippetBlock component for code + copy"
```

---

## Task 3: Build the `/dashboard/docs` page

The full setup guide. Five sections rendered in order: pick a token, settings.json snippet, where settings.json lives, verify, troubleshooting.

**Files:**
- Create: `next-app/app/dashboard/docs/page.tsx`

- [ ] **Step 1: Create the page file with the full implementation**

Create `next-app/app/dashboard/docs/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SnippetBlock } from "@/app/dashboard/components/SnippetBlock";
import { maskedSecret } from "@/lib/utils";
import type { UserToken } from "@/lib/db";

const TOKEN_PLACEHOLDER = "<YOUR_API_TOKEN>";
const URL_PLACEHOLDER = "<YOUR_PROXY_URL>";

function buildSnippet(baseUrl: string, token: string): string {
  return JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
      },
    },
    null,
    2,
  );
}

export default function DocsPage() {
  const [origin, setOrigin] = useState("");
  const [tokens, setTokens] = useState<UserToken[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/user-tokens", { cache: "no-store" });
    const data = await res.json();
    const list: UserToken[] = data.tokens || [];
    setTokens(list);
    const firstActive = list.find((t) => !t.revokedAt);
    if (firstActive) setSelectedId(firstActive.id);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeTokens = useMemo(
    () => (tokens ?? []).filter((t) => !t.revokedAt),
    [tokens],
  );

  const selectedToken = useMemo(
    () => activeTokens.find((t) => t.id === selectedId) ?? null,
    [activeTokens, selectedId],
  );

  const baseUrlForSnippet = origin || URL_PLACEHOLDER;
  const tokenForSnippet = selectedToken?.secret ?? TOKEN_PLACEHOLDER;
  const snippet = buildSnippet(baseUrlForSnippet, tokenForSnippet);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Setup guide</h1>
        <p className="text-sm text-muted-foreground">
          Point Claude Code at this proxy in under a minute.
        </p>
      </div>

      {/* Section 1 — Pick a token */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Pick a token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {tokens === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : activeTokens.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                You don&apos;t have any active tokens yet. Create one to fill in the snippet below.
              </p>
              <Button asChild size="sm">
                <Link href="/dashboard/tokens">Create a token</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {activeTokens.length > 1 ? (
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="token-select">
                    Choose which token to embed
                  </label>
                  <Select
                    value={selectedId ?? undefined}
                    onValueChange={(v) => setSelectedId(v)}
                  >
                    <SelectTrigger id="token-select" className="w-full sm:w-80">
                      <SelectValue placeholder="Select a token" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeTokens.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name || "(unnamed)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {selectedToken ? (
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs break-all">
                    {revealed ? selectedToken.secret : maskedSecret(selectedToken.secret)}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setRevealed((r) => !r)}
                    aria-label={revealed ? "Hide token" : "Show token"}
                  >
                    {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2 — Add to settings.json */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Add to Claude Code&apos;s settings.json</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SnippetBlock language="json" code={snippet} />
          <p className="text-xs text-muted-foreground">
            If you&apos;re viewing this through an SSH tunnel, replace the host in{" "}
            <code>ANTHROPIC_BASE_URL</code> with the server&apos;s public address before copying.
          </p>
        </CardContent>
      </Card>

      {/* Section 3 — Where is settings.json */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Where is settings.json?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="font-medium">User-level (recommended)</div>
            <div className="text-muted-foreground">
              <code>~/.claude/settings.json</code> on macOS / Linux ·{" "}
              <code>%USERPROFILE%\.claude\settings.json</code> on Windows
            </div>
          </div>
          <div>
            <div className="font-medium">Project-level</div>
            <div className="text-muted-foreground">
              <code>.claude/settings.json</code> in the repo root — overrides user-level for that project.
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Create the file if it doesn&apos;t exist. Merge the <code>env</code> block with anything
            already in the file.
          </p>
        </CardContent>
      </Card>

      {/* Section 4 — Verify */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Verify it works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm">Check the proxy is reachable:</p>
            <SnippetBlock language="bash" code={`curl ${baseUrlForSnippet}/health`} />
            <p className="text-xs text-muted-foreground">
              Expected: JSON like <code>{`{"status":"ok","auth":"oauth","accounts":N}`}</code>.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm">Send a test message through Claude Code:</p>
            <SnippetBlock language="bash" code={`claude -p "say hello"`} />
            <p className="text-xs text-muted-foreground">
              Or, if you don&apos;t have the Claude CLI handy, send a one-shot request directly:
            </p>
            <SnippetBlock
              language="bash"
              code={`curl ${baseUrlForSnippet}/v1/messages \\
  -H "Authorization: Bearer ${tokenForSnippet}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"say hello"}]}'`}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 5 — Troubleshooting */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Troubleshooting</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium">
                <code>401 Unauthorized</code>
              </dt>
              <dd className="text-muted-foreground">
                Token is wrong or revoked. Check{" "}
                <Link className="underline" href="/dashboard/tokens">/dashboard/tokens</Link>.
              </dd>
            </div>
            <div>
              <dt className="font-medium">
                <code>Cannot connect</code> / <code>ECONNREFUSED</code>
              </dt>
              <dd className="text-muted-foreground">
                <code>ANTHROPIC_BASE_URL</code> host is unreachable from where Claude Code is
                running (firewall, tunnel, wrong IP).
              </dd>
            </div>
            <div>
              <dt className="font-medium">Works locally, fails from another machine</dt>
              <dd className="text-muted-foreground">
                You&apos;re likely using <code>localhost</code> from a tunnel; switch to the
                server&apos;s public address.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Upstream <code>5xx</code> from Claude</dt>
              <dd className="text-muted-foreground">
                Check{" "}
                <Link className="underline" href="/dashboard/health">/dashboard/health</Link>{" "}
                for account status; the proxy may need an upstream token refresh.
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm -w next-app run build
```

Expected: build completes with no errors.

- [ ] **Step 3: Manual smoke check — page renders correctly**

```bash
npm run dev
```

Open `http://localhost:3000/dashboard/docs`. Verify:
- All five sections render (header, pick a token, settings.json snippet, where, verify, troubleshooting).
- The settings.json snippet shows the current origin (the URL in your address bar) and either your most recent token (masked) or the placeholder.
- Reveal eye toggle flips the token to plaintext.
- Copy buttons in each `SnippetBlock` write to clipboard (paste somewhere to confirm).

If you have multiple active tokens, verify the `<Select>` switches the embedded token in real time.

If you have zero active tokens (revoke them all temporarily, or test with a fresh user), verify the empty-state CTA appears and the snippet shows `<YOUR_API_TOKEN>`.

- [ ] **Step 4: Commit**

```bash
git add next-app/app/dashboard/docs/page.tsx
git commit -m "feat(dashboard): add /dashboard/docs setup guide page"
```

---

## Task 4: Add the inline "Use this token in Claude Code" card to `/dashboard/tokens`

A compact card placed between the page header and the existing "Generate a new token" card. Same snippet shape and selection logic as the docs page, minus the surrounding sections.

**Files:**
- Modify: `next-app/app/dashboard/tokens/page.tsx`

- [ ] **Step 1: Add the imports**

In `next-app/app/dashboard/tokens/page.tsx`, add to the imports at the top of the file (alongside the existing imports):

```ts
import Link from "next/link";
import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SnippetBlock } from "@/app/dashboard/components/SnippetBlock";
```

If `useMemo` is not yet in the existing `react` import, merge it: change `import { useCallback, useEffect, useState } from "react";` to `import { useCallback, useEffect, useMemo, useState } from "react";`.

- [ ] **Step 2: Add origin state and the inline-snippet selection state**

In the `TokensPage` component, just below the existing `useState` declarations (after `const [busyId, setBusyId] = useState<string | null>(null);`), add:

```ts
const [snippetOrigin, setSnippetOrigin] = useState("");
const [snippetTokenId, setSnippetTokenId] = useState<string | null>(null);

useEffect(() => {
  setSnippetOrigin(window.location.origin);
}, []);
```

After the existing `load` callback, add an effect that picks a default token whenever the list updates:

```ts
useEffect(() => {
  if (!tokens) return;
  const firstActive = tokens.find((t) => !t.revokedAt);
  // Only initialize once; don't override the user's manual selection.
  setSnippetTokenId((current) => {
    if (current && tokens.some((t) => t.id === current && !t.revokedAt)) return current;
    return firstActive?.id ?? null;
  });
}, [tokens]);
```

- [ ] **Step 3: Compute the snippet**

Inside the component, just before the `return (`, add:

```ts
const activeTokens = useMemo(
  () => (tokens ?? []).filter((t) => !t.revokedAt),
  [tokens],
);
const snippetToken = activeTokens.find((t) => t.id === snippetTokenId) ?? null;
const snippetBaseUrl = snippetOrigin || "<YOUR_PROXY_URL>";
const snippetTokenValue = snippetToken?.secret ?? "<YOUR_API_TOKEN>";
const snippetCode = JSON.stringify(
  {
    env: {
      ANTHROPIC_BASE_URL: snippetBaseUrl,
      ANTHROPIC_AUTH_TOKEN: snippetTokenValue,
    },
  },
  null,
  2,
);
```

- [ ] **Step 4: Insert the inline card**

Insert this block in the JSX, immediately after the closing `</div>` of the page header (i.e., right before the existing `<Card>` titled "Generate a new token"):

```tsx
<Card>
  <CardHeader className="pb-3">
    <CardTitle className="text-base">Use this token in Claude Code</CardTitle>
  </CardHeader>
  <CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">
      Add the following to <code>~/.claude/settings.json</code>. Claude Code will route
      requests through this proxy.
    </p>
    {activeTokens.length > 1 ? (
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground" htmlFor="snippet-token-select">
          Embed which token?
        </label>
        <Select
          value={snippetTokenId ?? undefined}
          onValueChange={(v) => setSnippetTokenId(v)}
        >
          <SelectTrigger id="snippet-token-select" className="w-full sm:w-80">
            <SelectValue placeholder="Select a token" />
          </SelectTrigger>
          <SelectContent>
            {activeTokens.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name || "(unnamed)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null}
    <SnippetBlock language="json" code={snippetCode} />
    {activeTokens.length === 0 ? (
      <p className="text-xs text-muted-foreground">
        Generate a token below to fill this in.
      </p>
    ) : null}
    <p className="text-xs text-muted-foreground">
      Need help finding <code>settings.json</code> or troubleshooting?{" "}
      <Link className="underline" href="/dashboard/docs">
        Open the full setup guide →
      </Link>
    </p>
  </CardContent>
</Card>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm -w next-app run build
```

Expected: build completes with no errors.

- [ ] **Step 6: Manual smoke check — inline card behaves**

```bash
npm run dev
```

Open `http://localhost:3000/dashboard/tokens`. Verify:
- The new "Use this token in Claude Code" card sits between the header and the "Generate a new token" card.
- The snippet shows the current origin and your most recent token's full secret.
- Generating a new token causes the snippet to refresh to the newest token automatically.
- With multiple tokens present, the `<Select>` switches the embedded token.
- With zero active tokens (revoke everything, then refresh), the snippet shows `<YOUR_API_TOKEN>` and the "Generate a token below" hint appears.
- Copy button in the snippet writes the JSON to clipboard.
- The "Open the full setup guide →" link navigates to `/dashboard/docs`.

- [ ] **Step 7: Commit**

```bash
git add next-app/app/dashboard/tokens/page.tsx
git commit -m "feat(dashboard): inline 'Use this token in Claude Code' snippet on tokens page"
```

---

## Task 5: Add the sidebar nav entry

**Files:**
- Modify: `next-app/app/dashboard/components/Sidebar.tsx`

- [ ] **Step 1: Update the nav array**

In `next-app/app/dashboard/components/Sidebar.tsx`:

Change the import from `lucide-react` (currently `import { Home, BarChart3, FileText, HeartPulse, KeyRound, LogOut, Users, Trophy } from "lucide-react";`) to also include `BookOpen`:

```ts
import { Home, BarChart3, BookOpen, FileText, HeartPulse, KeyRound, LogOut, Users, Trophy } from "lucide-react";
```

Replace the `navItems` array with:

```ts
const navItems = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/accounts", label: "Accounts", icon: Users },
  { href: "/dashboard/tokens", label: "API tokens", icon: KeyRound },
  { href: "/dashboard/docs", label: "Setup guide", icon: BookOpen },
  { href: "/dashboard/usage", label: "Usage", icon: BarChart3 },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/dashboard/logs", label: "Logs", icon: FileText },
  { href: "/dashboard/health", label: "Health", icon: HeartPulse },
];
```

(The new entry is inserted between "API tokens" and "Usage".)

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm -w next-app run build
```

Expected: build completes with no errors.

- [ ] **Step 3: Manual smoke check — sidebar entry**

```bash
npm run dev
```

Open any dashboard page. Verify:
- "Setup guide" appears in the sidebar between "API tokens" and "Usage" with a book icon.
- Clicking it navigates to `/dashboard/docs`.
- On `/dashboard/docs`, the "Setup guide" entry shows the active highlight (matches the existing active-link style).

- [ ] **Step 4: Commit**

```bash
git add next-app/app/dashboard/components/Sidebar.tsx
git commit -m "feat(dashboard): add Setup guide entry to sidebar"
```

---

## Task 6: Final integrated smoke test

A single end-to-end pass to make sure the surfaces don't drift and the full happy path works.

**Files:** None modified.

- [ ] **Step 1: Run dev servers**

```bash
npm run dev
```

- [ ] **Step 2: Walk the happy path**

Open `http://localhost:3000/dashboard/tokens`.

1. Generate a fresh token named `setup-guide-test`.
2. Confirm the inline "Use this token in Claude Code" card auto-fills with that token's secret and the current origin.
3. Click "Open the full setup guide →".
4. On `/dashboard/docs`, confirm the embedded token in Section 2 matches what was shown on the tokens page (same default selection rule = most recent active token).
5. Switch the `<Select>` (if you have multiple tokens) on the docs page; confirm Section 2's snippet AND Section 4's `curl` example both update.
6. Copy the snippet from the docs page, paste it into a scratch file, and confirm it is valid JSON (`python3 -m json.tool < scratch.json` or paste into `jq`).
7. From a terminal, run the `curl <origin>/health` command shown in Section 4 and confirm it returns the expected JSON.
8. Revoke the test token from the tokens page; reload the docs page; confirm the snippet auto-selects another active token (or shows the placeholder + CTA if none remain).

- [ ] **Step 3: Tunnel-access sanity check (optional but recommended)**

If you can SSH-tunnel from another machine (or just access via a non-localhost address like the LAN IP), open the dashboard via that address and confirm the snippet on both surfaces reflects the new origin. This is the scenario the trailing note in Section 2 calls out.

- [ ] **Step 4: No commit**

This task only verifies. If anything is broken, go back to the offending earlier task, fix, and re-commit there.

---

## Done criteria

- `/dashboard/docs` renders the five-section guide and copies the correct snippet for whichever active token is selected.
- `/dashboard/tokens` shows an inline snippet card above "Generate a new token" with the same content shape.
- Sidebar has a "Setup guide" entry that highlights when on `/dashboard/docs`.
- `npm -w next-app run build` passes.
- All manual smoke checks above pass.
- No backend, schema, or API route changes.
