"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddAccountDialog } from "./AddAccountDialog";
import { AccountDetailDialog } from "./AccountDetailDialog";

interface AccountRow {
  id: string;
  name: string;
  email: string | null;
  expiresAt: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  accessTokenPreview: string | null;
  hasRefreshToken: boolean;
}

type StatusTone = "default" | "secondary" | "destructive";
function statusOf(account: AccountRow): { label: string; tone: StatusTone } {
  if (!account.isActive) return { label: "disabled", tone: "secondary" };
  if (account.lastError) return { label: "error", tone: "destructive" };
  return { label: "active", tone: "default" };
}

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

export default function AccountsPage() {
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;

  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [roundRobin, setRoundRobin] = useState<boolean | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyRR, setBusyRR] = useState(false);

  const load = useCallback(async () => {
    const [accRes, setRes] = await Promise.all([
      fetch("/api/claude/accounts"),
      fetch("/api/claude/settings"),
    ]);
    const accData = await accRes.json();
    const setData = await setRes.json();
    setAccounts(accData.accounts || []);
    setRoundRobin(setData.settings?.roundRobin ?? true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setActive = async (account: AccountRow, next: boolean) => {
    setBusyId(account.id);
    // Optimistic update
    setAccounts((cur) =>
      cur ? cur.map((a) => (a.id === account.id ? { ...a, isActive: next } : a)) : cur
    );
    try {
      await fetch(`/api/claude/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
    } finally {
      setBusyId(null);
      load();
    }
  };

  const setRR = async (next: boolean) => {
    setBusyRR(true);
    setRoundRobin(next);
    try {
      await fetch("/api/claude/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundRobin: next }),
      });
    } finally {
      setBusyRR(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Claude accounts</h1>
          <p className="text-muted-foreground">
            Click a row for details and actions.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>Add Claude account</Button>
      </div>

      {isAdmin && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Round-robin</div>
              <p className="text-xs text-muted-foreground">
                {roundRobin === false
                  ? "Off — requests stick to the oldest active account; failover only on auth/rate-limit errors."
                  : "On — least-recently-used active account is picked for each request."}
              </p>
            </div>
            <Switch
              checked={roundRobin ?? true}
              disabled={busyRR || roundRobin === null}
              onCheckedChange={setRR}
              aria-label="Toggle round-robin"
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {accounts === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No accounts yet. Add one to start serving requests.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {isAdmin && <TableHead className="w-12">On</TableHead>}
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Last used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const status = statusOf(account);
                  return (
                    <TableRow
                      key={account.id}
                      onClick={() => setDetailId(account.id)}
                      className="cursor-pointer"
                    >
                      {isAdmin && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Switch
                            checked={account.isActive}
                            disabled={busyId === account.id}
                            onCheckedChange={(next) => setActive(account, next)}
                            aria-label={`Toggle ${account.name}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="font-medium">{account.name}</div>
                        {account.email && (
                          <div className="text-xs text-muted-foreground">{account.email}</div>
                        )}
                        {account.lastError && (
                          <div
                            className="text-xs text-destructive truncate max-w-xs"
                            title={account.lastError}
                          >
                            {account.lastError}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.tone}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {account.accessTokenPreview || "—"}
                      </TableCell>
                      <TableCell>{relative(account.lastUsedAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} onAdded={load} />

      <AccountDetailDialog
        accountId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={load}
        canEdit={isAdmin}
      />
    </div>
  );
}
