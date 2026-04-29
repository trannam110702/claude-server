"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccountRow {
  id: string;
  name: string;
  email: string | null;
  expiresAt: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  hasRefreshToken: boolean;
}

interface Quota {
  used: number;
  total: number;
  remaining: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited?: boolean;
}

interface UsageResponse {
  plan?: string;
  quotas?: Record<string, Quota>;
  error?: string;
  fetchedAt?: string;
}

const REFRESH_INTERVAL_MS = 60_000;

function formatResetCountdown(date: string | null): string {
  if (!date) return "—";
  const diff = new Date(date).getTime() - Date.now();
  if (diff <= 0) return "now";
  const totalMin = Math.ceil(diff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalH = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (totalH < 24) return `${totalH}h ${m}m`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return `${d}d ${h}h ${m}m`;
}

function formatResetAbsolute(date: string | null): string {
  if (!date) return "";
  return new Date(date).toLocaleString();
}

function statusFor(remaining: number) {
  if (remaining > 70) {
    return {
      label: "healthy",
      emoji: "🟢",
      text: "text-green-600 dark:text-green-500",
      // Tailwind arbitrary descendant selector targets the indicator slot.
      indicator: "[&_[data-slot=progress-indicator]]:bg-green-500",
    };
  }
  if (remaining >= 30) {
    return {
      label: "warning",
      emoji: "🟡",
      text: "text-yellow-600 dark:text-yellow-500",
      indicator: "[&_[data-slot=progress-indicator]]:bg-yellow-500",
    };
  }
  return {
    label: "critical",
    emoji: "🔴",
    text: "text-red-600 dark:text-red-500",
    indicator: "[&_[data-slot=progress-indicator]]:bg-red-500",
  };
}

function QuotaRow({ name, quota }: { name: string; quota: Quota }) {
  const remaining = Math.round(quota.remainingPercentage ?? quota.remaining ?? 0);
  const status = statusFor(remaining);
  return (
    <div className="space-y-1.5">
      <Progress value={remaining} className={cn("w-full", status.indicator)}>
        <ProgressLabel className="capitalize">{name}</ProgressLabel>
        <ProgressValue
          render={
            <span className={cn("ml-auto font-medium", status.text)}>
              {status.emoji} {remaining}% left
            </span>
          }
        />
      </Progress>
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{quota.used}% used</span>
        {quota.resetAt && (
          <span title={formatResetAbsolute(quota.resetAt)}>
            resets in {formatResetCountdown(quota.resetAt)}
          </span>
        )}
      </div>
    </div>
  );
}

function AccountUsageCard({
  account,
  usage,
  loading,
  error,
  onRefresh,
}: {
  account: AccountRow;
  usage: UsageResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const expiresAtMs = account.expiresAt ? new Date(account.expiresAt).getTime() : null;
  const tokenBadge = !account.isActive
    ? { label: "disabled", variant: "secondary" as const }
    : !expiresAtMs
    ? { label: "no expiry", variant: "secondary" as const }
    : expiresAtMs - Date.now() < 0
    ? { label: "token expired", variant: "destructive" as const }
    : expiresAtMs - Date.now() < 24 * 3_600_000
    ? { label: "expiring soon", variant: "secondary" as const }
    : { label: "active", variant: "default" as const };

  const quotaEntries = usage?.quotas ? Object.entries(usage.quotas) : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{account.name}</CardTitle>
          {account.email && (
            <p className="text-xs text-muted-foreground">{account.email}</p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Badge variant={tokenBadge.variant}>{tokenBadge.label}</Badge>
            {usage?.plan && <Badge variant="outline">{usage.plan}</Badge>}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh usage"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {!error && !usage && loading && (
          <p className="text-sm text-muted-foreground">Loading usage…</p>
        )}
        {!error && usage && quotaEntries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {usage.error || "No quota data returned by Anthropic."}
          </p>
        )}
        {quotaEntries.length > 0 && (
          <div className="space-y-4">
            {quotaEntries.map(([name, quota]) => (
              <QuotaRow key={name} name={name} quota={quota} />
            ))}
          </div>
        )}
        {usage?.fetchedAt && (
          <p className="pt-1 text-[10px] text-muted-foreground">
            updated {new Date(usage.fetchedAt).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function HealthPage() {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [usageMap, setUsageMap] = useState<Record<string, UsageResponse | null>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string | null>>({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_MS / 1000);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/claude/accounts");
    const data = await res.json();
    setAccounts((data.accounts as AccountRow[]) || []);
    return (data.accounts as AccountRow[]) || [];
  }, []);

  const fetchUsageFor = useCallback(async (id: string) => {
    setLoadingMap((m) => ({ ...m, [id]: true }));
    setErrorMap((m) => ({ ...m, [id]: null }));
    try {
      const res = await fetch(`/api/claude/accounts/${id}/usage`);
      const data: UsageResponse = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.error) {
        setErrorMap((m) => ({ ...m, [id]: data.error! }));
        setUsageMap((m) => ({ ...m, [id]: null }));
      } else {
        setUsageMap((m) => ({ ...m, [id]: data }));
      }
    } catch (err) {
      setErrorMap((m) => ({ ...m, [id]: (err as Error).message }));
    } finally {
      setLoadingMap((m) => ({ ...m, [id]: false }));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    const list = accounts ?? (await loadAccounts());
    await Promise.all(list.filter((a) => a.isActive).map((a) => fetchUsageFor(a.id)));
    setCountdown(REFRESH_INTERVAL_MS / 1000);
  }, [accounts, loadAccounts, fetchUsageFor]);

  // Initial load
  useEffect(() => {
    (async () => {
      const list = await loadAccounts();
      await Promise.all(list.filter((a) => a.isActive).map((a) => fetchUsageFor(a.id)));
    })();
  }, [loadAccounts, fetchUsageFor]);

  // Auto-refresh, paused when tab hidden
  useEffect(() => {
    const start = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      intervalRef.current = setInterval(refreshAll, REFRESH_INTERVAL_MS);
      tickRef.current = setInterval(() => {
        setCountdown((c) => (c <= 1 ? REFRESH_INTERVAL_MS / 1000 : c - 1));
      }, 1000);
    };
    const stop = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      intervalRef.current = null;
      tickRef.current = null;
    };

    if (!autoRefresh) {
      stop();
      return;
    }
    start();
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoRefresh, refreshAll]);

  const activeAccounts = accounts?.filter((a) => a.isActive) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Health</h1>
          <p className="text-muted-foreground">
            Per-account Claude quota — pulled from Anthropic&apos;s OAuth usage endpoint.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {autoRefresh ? `next refresh in ${countdown}s` : "auto-refresh off"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? "Pause" : "Resume"}
          </Button>
          <Button size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh now
          </Button>
        </div>
      </div>

      {accounts === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : activeAccounts.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No active Claude accounts. Add one on{" "}
            <a className="underline" href="/dashboard/accounts">/dashboard/accounts</a>.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {activeAccounts.map((account) => (
            <AccountUsageCard
              key={account.id}
              account={account}
              usage={usageMap[account.id] || null}
              loading={!!loadingMap[account.id]}
              error={errorMap[account.id] || null}
              onRefresh={() => fetchUsageFor(account.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
