"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccountDetail {
  account: {
    id: string;
    name: string;
    email: string | null;
    fullName: string | null;
    organizationName: string | null;
    organizationId: string | null;
    accountUuid: string | null;
    plan: string | null;
    isActive: boolean;
    scope: string | null;
    expiresAt: string | null;
    lastUsedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    createdAt: string;
    updatedAt: string;
    accessTokenPreview: string | null;
    hasRefreshToken: boolean;
  };
  profile?: {
    email?: string | null;
    fullName?: string | null;
    organizationName?: string | null;
    organizationId?: string | null;
    accountUuid?: string | null;
  };
  usage?: {
    plan?: string;
    quotas?: Record<
      string,
      { used: number; total: number; remaining: number; remainingPercentage: number; resetAt: string | null }
    >;
    error?: string;
    fetchedAt?: string;
  };
  activity?: {
    total?: { requests?: number; input_tokens?: number; output_tokens?: number; errors?: number; last_request_at?: string | null };
    last24h?: { requests?: number; input_tokens?: number; output_tokens?: number };
  };
}

function statusFor(remaining: number) {
  if (remaining > 70) return { tone: "text-green-600 dark:text-green-500", bar: "[&_[data-slot=progress-indicator]]:bg-green-500" };
  if (remaining >= 30) return { tone: "text-yellow-600 dark:text-yellow-500", bar: "[&_[data-slot=progress-indicator]]:bg-yellow-500" };
  return { tone: "text-red-600 dark:text-red-500", bar: "[&_[data-slot=progress-indicator]]:bg-red-500" };
}

function formatResetCountdown(date: string | null | undefined) {
  if (!date) return "—";
  const diff = new Date(date).getTime() - Date.now();
  if (diff <= 0) return "now";
  const min = Math.ceil(diff / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtNum(n: number | null | undefined) {
  return n == null ? "—" : n.toLocaleString();
}

function fmtDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function AccountDetailDialog({
  accountId,
  onClose,
  onChanged,
  canEdit = false,
}: {
  accountId: string | null;
  onClose: () => void;
  onChanged?: () => void;
  canEdit?: boolean;
}) {
  const [data, setData] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/claude/accounts/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId) {
      setData(null);
      setError(null);
      return;
    }
    reload(accountId);
  }, [accountId, reload]);

  const a = data?.account;
  const quotas = data?.usage?.quotas ? Object.entries(data.usage.quotas) : [];

  const toggleActive = async () => {
    if (!a) return;
    setBusy(true);
    try {
      await fetch(`/api/claude/accounts/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !a.isActive }),
      });
      await reload(a.id);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!a) return;
    const next = window.prompt("New name", a.name);
    if (!next || next === a.name) return;
    setBusy(true);
    try {
      await fetch(`/api/claude/accounts/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      await reload(a.id);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const refreshToken = async () => {
    if (!a) return;
    setBusy(true);
    try {
      await fetch(`/api/claude/accounts/${a.id}/refresh`, { method: "POST" });
      await reload(a.id);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!a) return;
    if (!window.confirm(`Delete "${a.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/claude/accounts/${a.id}`, { method: "DELETE" });
      onChanged?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!accountId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader className="flex flex-row items-start justify-between gap-2">
          <DialogTitle>{a?.name || "Account details"}</DialogTitle>
          {a && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => reload(a.id)}
              disabled={loading || busy}
              aria-label="Reload"
              className="-mt-1 -mr-1"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          )}
        </DialogHeader>

        {loading && !data && <p className="text-sm text-muted-foreground py-4">Loading…</p>}
        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {a && (
          <div className="space-y-5 text-sm">
            <Section title="Identity">
              <Row label="Name" value={a.name} />
              <Row label="Email" value={a.email} mono />
              <Row label="Full name" value={a.fullName} />
              <Row label="Organization" value={a.organizationName} />
              <Row label="Organization ID" value={a.organizationId} mono />
              <Row label="Account UUID" value={a.accountUuid} mono />
              <Row
                label="Plan"
                value={a.plan ? <Badge variant="outline">{a.plan}</Badge> : "—"}
              />
            </Section>

            <Section title="Token">
              <Row label="Account ID" value={a.id} mono />
              <Row
                label="Status"
                value={
                  !a.isActive ? (
                    <Badge variant="secondary">disabled</Badge>
                  ) : a.lastError ? (
                    <Badge variant="destructive">error</Badge>
                  ) : (
                    <Badge>active</Badge>
                  )
                }
              />
              <Row label="Scope" value={a.scope} mono />
              <Row label="Access token" value={a.accessTokenPreview} mono />
              <Row label="Refresh token" value={a.hasRefreshToken ? "✓ stored" : "—"} />
              <Row label="Expires" value={fmtDate(a.expiresAt)} />
              <Row label="Last used" value={fmtDate(a.lastUsedAt)} />
              <Row label="Created" value={fmtDate(a.createdAt)} />
              <Row label="Updated" value={fmtDate(a.updatedAt)} />
              {a.lastError && (
                <Row
                  label="Last error"
                  value={
                    <span className="text-destructive">
                      {a.lastError}{" "}
                      <span className="text-muted-foreground">({fmtDate(a.lastErrorAt)})</span>
                    </span>
                  }
                />
              )}
            </Section>

            <Section title="Live quota">
              {data?.usage?.error ? (
                <p className="text-sm text-destructive">{data.usage.error}</p>
              ) : quotas.length === 0 ? (
                <p className="text-sm text-muted-foreground">No quota data returned.</p>
              ) : (
                <div className="space-y-3">
                  {quotas.map(([name, q]) => {
                    const remaining = Math.round(q.remainingPercentage ?? q.remaining ?? 0);
                    const s = statusFor(remaining);
                    return (
                      <div key={name} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium capitalize">{name}</span>
                          <span className={cn("font-medium tabular-nums", s.tone)}>
                            {remaining}% left
                          </span>
                        </div>
                        <Progress value={remaining} className={cn("w-full", s.bar)} />
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                          <span>{q.used}% used</span>
                          {q.resetAt && <span>resets in {formatResetCountdown(q.resetAt)}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            <Section title="Activity (this proxy)">
              <Row label="Requests (total)" value={fmtNum(data?.activity?.total?.requests)} />
              <Row
                label="Tokens (total)"
                value={`${fmtNum(data?.activity?.total?.input_tokens)} in / ${fmtNum(data?.activity?.total?.output_tokens)} out`}
              />
              <Row label="Errors (total)" value={fmtNum(data?.activity?.total?.errors)} />
              <Row label="Last request" value={fmtDate(data?.activity?.total?.last_request_at)} />
              <Row label="Requests (24h)" value={fmtNum(data?.activity?.last24h?.requests)} />
              <Row
                label="Tokens (24h)"
                value={`${fmtNum(data?.activity?.last24h?.input_tokens)} in / ${fmtNum(data?.activity?.last24h?.output_tokens)} out`}
              />
            </Section>

            {canEdit && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
                <Button variant="ghost" size="sm" onClick={rename} disabled={busy}>
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={refreshToken}
                  disabled={busy || !a.hasRefreshToken}
                >
                  Refresh token
                </Button>
                <Button variant="outline" size="sm" onClick={toggleActive} disabled={busy}>
                  {a.isActive ? "Disable" : "Enable"}
                </Button>
                <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  const empty = value == null || value === "" || value === "—";
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3">
      <div className="text-xs text-muted-foreground self-center">{label}</div>
      <div
        className={cn(
          "text-sm break-words",
          mono && "font-mono text-xs",
          empty && "text-muted-foreground"
        )}
      >
        {empty ? "—" : value}
      </div>
    </div>
  );
}
