"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Medal, RefreshCw } from "lucide-react";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
] as const;
type Period = (typeof PERIODS)[number]["value"];

const SORTS = [
  { value: "total_tokens", label: "By total tokens" },
  { value: "requests", label: "By requests" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

interface Row {
  user_email: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_active: string;
}

interface LeaderboardResponse {
  period: Period;
  sort: Sort;
  rows: Row[];
}

const fmtNum = (n: number | null | undefined) =>
  n == null ? "0" : n.toLocaleString();

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

const MEDAL_TONE = [
  "text-yellow-500",   // 1st
  "text-zinc-400",     // 2nd
  "text-amber-700",    // 3rd
];

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [sort, setSort] = useState<Sort>("total_tokens");
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: Period, s: Sort) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/usage/leaderboard?period=${p}&sort=${s}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period, sort);
  }, [period, sort, load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Leaderboard</h1>
          <p className="text-sm text-muted-foreground">
            Top token consumers across all registered users.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill
            options={PERIODS}
            value={period}
            onChange={(v) => setPeriod(v as Period)}
            disabled={loading}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(period, sort)}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Ranking</CardTitle>
            <CardDescription>
              {data?.rows?.length ?? 0} user{data?.rows?.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <Pill
            options={SORTS}
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            disabled={loading}
          />
        </CardHeader>
        <CardContent>
          {data === null ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No usage data for this period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Last active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={r.user_email}>
                    <TableCell className="font-medium">
                      {i < 3 ? (
                        <span className="inline-flex items-center gap-1">
                          <Medal className={cn("h-4 w-4", MEDAL_TONE[i])} />
                          {i + 1}
                        </span>
                      ) : (
                        i + 1
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{r.user_email}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      sort === "requests" && "font-semibold"
                    )}>
                      {fmtNum(r.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.input_tokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(r.output_tokens)}</TableCell>
                    <TableCell className={cn(
                      "text-right tabular-nums",
                      sort === "total_tokens" && "font-semibold"
                    )}>
                      {fmtNum(r.total_tokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {relative(r.last_active)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Pill<T extends { value: string; label: string }>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly T[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-3 py-1 rounded text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
