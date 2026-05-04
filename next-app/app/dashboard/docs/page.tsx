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
