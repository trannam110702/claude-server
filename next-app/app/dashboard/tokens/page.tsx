"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { maskedSecret } from "@/lib/utils";
import type { UserToken } from "@/lib/db";
import { SnippetBlock } from "@/app/dashboard/components/SnippetBlock";
import { buildSettingsSnippet, TOKEN_PLACEHOLDER, URL_PLACEHOLDER } from "@/lib/settingsSnippet";

function relative(time: string | null) {
  if (!time) return "—";
  const diff = Date.now() - new Date(time).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<UserToken[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [snippetOrigin, setSnippetOrigin] = useState("");
  const [snippetTokenId, setSnippetTokenId] = useState<string | null>(null);

  useEffect(() => {
    setSnippetOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/user-tokens", { cache: "no-store" });
    const data = await res.json();
    setTokens(data.tokens || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!tokens) return;
    const firstActive = tokens.find((t) => !t.revokedAt);
    setSnippetTokenId((current) => {
      if (current && tokens.some((t) => t.id === current && !t.revokedAt)) return current;
      return firstActive?.id ?? null;
    });
  }, [tokens]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create token");
      // Auto-reveal the just-created one so the user can copy it immediately.
      if (data.token?.id) {
        setRevealed((m) => ({ ...m, [data.token.id]: true }));
      }
      setName("");
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: UserToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Clients using this token will stop working.`)) return;
    setBusyId(token.id);
    try {
      await fetch(`/api/user-tokens/${token.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (token: UserToken) => {
    try {
      await navigator.clipboard.writeText(token.secret);
      setCopied(token.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const activeTokens = useMemo(
    () => (tokens ?? []).filter((t) => !t.revokedAt),
    [tokens],
  );
  const snippetToken = activeTokens.find((t) => t.id === snippetTokenId) ?? null;
  const snippetBaseUrl = snippetOrigin || URL_PLACEHOLDER;
  const snippetTokenValue = snippetToken?.secret ?? TOKEN_PLACEHOLDER;
  const snippetCode = buildSettingsSnippet(snippetBaseUrl, snippetTokenValue);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">API tokens</h1>
        <p className="text-sm text-muted-foreground">
          Tokens for calling <code>/v1/messages</code> and <code>/v1/chat/completions</code>.
          Pass in the request as <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Use this token in Claude Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {snippetOrigin === "" ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
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
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Generate a new token</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="token-name">Label (optional)</Label>
            <Input
              id="token-name"
              placeholder="e.g. laptop-cli, ci-runner"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button onClick={create} disabled={creating}>
            {creating ? "Generating…" : "Generate token"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your tokens</CardTitle>
        </CardHeader>
        <CardContent>
          {tokens === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => {
                  const show = !!revealed[t.id];
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-xs break-all">
                            {show ? t.secret : maskedSecret(t.secret)}
                          </code>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() =>
                              setRevealed((m) => ({ ...m, [t.id]: !show }))
                            }
                            aria-label={show ? "Hide token" : "Show token"}
                          >
                            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => copy(t)}
                            aria-label="Copy token"
                          >
                            {copied === t.id ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        {t.revokedAt ? (
                          <Badge variant="secondary">revoked</Badge>
                        ) : (
                          <Badge>active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{relative(t.createdAt)}</TableCell>
                      <TableCell className="text-xs">{relative(t.lastUsedAt)}</TableCell>
                      <TableCell className="text-right">
                        {!t.revokedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={busyId === t.id}
                            onClick={() => revoke(t)}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
