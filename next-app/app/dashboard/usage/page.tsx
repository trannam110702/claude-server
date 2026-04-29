"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
] as const;
type Period = (typeof PERIODS)[number]["value"];

interface AccountRow {
  account_id: string | null;
  account_name: string | null;
  account_email: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface ModelRow {
  model: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface SeriesPoint {
  bucket: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

interface StatsResponse {
  period: Period;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    errors: number;
    avgLatencyMs: number;
  };
  byAccount: AccountRow[];
  byModel: ModelRow[];
  series: SeriesPoint[];
}

const fmtNum = (n: number | null | undefined) =>
  n == null ? "0" : n.toLocaleString();

const shortNum = (n: number) => {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const bucketLabel = (iso: string, period: Period) => {
  const d = new Date(iso);
  if (period === "24h") return d.toLocaleTimeString([], { hour: "numeric" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

const PERIOD_COPY: Record<Period, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

const requestsConfig: ChartConfig = {
  requests: {
    label: "Requests",
    color: "var(--chart-1)",
  },
};

const tokensConfig: ChartConfig = {
  input: {
    label: "Input tokens",
    color: "var(--chart-2)",
  },
  output: {
    label: "Output tokens",
    color: "var(--chart-4)",
  },
};

export default function UsagePage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"requests" | "tokens">("requests");

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/stats?period=${p}`, { cache: "no-store" });
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.series.map((p) => ({
      label: bucketLabel(p.bucket, data.period),
      requests: p.requests,
      input: p.input_tokens,
      output: p.output_tokens,
    }));
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usage</h1>
          <p className="text-sm text-muted-foreground">
            Aggregated request and token usage across active Claude accounts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector value={period} onChange={setPeriod} disabled={loading} />
          <Button variant="outline" size="sm" onClick={() => load(period)} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Requests" value={fmtNum(data?.totals.requests)} />
        <StatCard label="Input tokens" value={fmtNum(data?.totals.inputTokens)} />
        <StatCard label="Output tokens" value={fmtNum(data?.totals.outputTokens)} />
        <StatCard
          label="Errors"
          value={fmtNum(data?.totals.errors)}
          tone={data && data.totals.errors > 0 ? "destructive" : "default"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">
              {view === "requests" ? "Requests over time" : "Tokens over time"}
            </CardTitle>
            <CardDescription>{PERIOD_COPY[period]}</CardDescription>
          </div>
          <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
            <ToggleButton active={view === "requests"} onClick={() => setView("requests")}>
              Requests
            </ToggleButton>
            <ToggleButton active={view === "tokens"} onClick={() => setView("tokens")}>
              Tokens
            </ToggleButton>
          </div>
        </CardHeader>
        <CardContent>
          {view === "requests" ? (
            <ChartContainer config={requestsConfig} className="aspect-auto h-64 w-full">
              <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-requests)" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="var(--color-requests)" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeOpacity={0.2} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={shortNum}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  dataKey="requests"
                  type="natural"
                  stroke="var(--color-requests)"
                  strokeWidth={2}
                  fill="url(#fillRequests)"
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <ChartContainer config={tokensConfig} className="aspect-auto h-64 w-full">
              <AreaChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-input)" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="var(--color-input)" stopOpacity={0.1} />
                  </linearGradient>
                  <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-output)" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="var(--color-output)" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeOpacity={0.2} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={shortNum}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  dataKey="input"
                  type="natural"
                  stackId="t"
                  stroke="var(--color-input)"
                  strokeWidth={2}
                  fill="url(#fillInput)"
                />
                <Area
                  dataKey="output"
                  type="natural"
                  stackId="t"
                  stroke="var(--color-output)"
                  strokeWidth={2}
                  fill="url(#fillOutput)"
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">By account</CardTitle>
          </CardHeader>
          <CardContent>
            <BreakdownTable
              rows={(data?.byAccount || []).map((r) => ({
                key: r.account_id || "n/a",
                label:
                  r.account_name ||
                  (r.account_id ? `${r.account_id.slice(0, 8)}…` : "API key / unknown"),
                sub: r.account_email || undefined,
                requests: r.requests,
                inputTokens: r.input_tokens,
                outputTokens: r.output_tokens,
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">By model</CardTitle>
          </CardHeader>
          <CardContent>
            <BreakdownTable
              rows={(data?.byModel || []).map((r) => ({
                key: r.model || "(unknown)",
                label: r.model || "(unknown)",
                requests: r.requests,
                inputTokens: r.input_tokens,
                outputTokens: r.output_tokens,
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PeriodSelector({
  value,
  onChange,
  disabled,
}: {
  value: Period;
  onChange: (v: Period) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          disabled={disabled}
          onClick={() => onChange(p.value)}
          className={cn(
            "px-3 py-1 rounded text-xs font-medium transition-colors",
            value === p.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1 rounded text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "destructive";
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-bold tabular-nums",
            tone === "destructive" && "text-destructive"
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownTable({
  rows,
}: {
  rows: { key: string; label: string; sub?: string; requests: number; inputTokens: number; outputTokens: number }[];
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No data</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead></TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell>
              <div className="text-sm font-medium">{r.label}</div>
              {r.sub && <div className="text-xs text-muted-foreground">{r.sub}</div>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(r.requests)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(r.inputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(r.outputTokens)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
