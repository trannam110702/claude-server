"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

interface Stats {
  requestsToday: number;
  avgLatencyMs: number;
  errorCountToday: number;
}

type LatencyPeriod = "24h" | "7d";

interface LatencyPoint {
  bucket: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  n: number;
}

interface LatencyResponse {
  period: LatencyPeriod;
  bucketSeconds: number;
  points: LatencyPoint[];
}

const LATENCY_CHART_CONFIG: ChartConfig = {
  p50: { label: "p50", color: "var(--chart-1)" },
  p95: { label: "p95", color: "var(--chart-2)" },
  p99: { label: "p99", color: "var(--chart-5)" },
};

function formatBucket(iso: string, period: LatencyPeriod): string {
  const d = new Date(iso);
  if (period === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((res) => res.json())
      .then(setStats)
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Welcome, {session?.user?.email}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Requests Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.requestsToday ?? "—"}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Latency</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.avgLatencyMs ?? "—"} ms</div>
          </CardContent>
        </Card>
      </div>

      <LatencyCard />
    </div>
  );
}

function LatencyCard() {
  const [period, setPeriod] = useState<LatencyPeriod>("24h");
  const [data, setData] = useState<LatencyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/stats/latency?period=${period}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json: LatencyResponse) => { if (!cancelled) setData(json); })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      label: formatBucket(p.bucket, data.period),
      p50: p.p50,
      p95: p.p95,
      p99: p.p99,
      n: p.n,
    }));
  }, [data]);

  const allEmpty = !!data && data.points.every((p) => p.n === 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">Latency</CardTitle>
          <p className="text-sm text-muted-foreground">p50 / p95 / p99 over time</p>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <PeriodButton active={period === "24h"} disabled={loading} onClick={() => setPeriod("24h")}>24h</PeriodButton>
          <PeriodButton active={period === "7d"} disabled={loading} onClick={() => setPeriod("7d")}>7d</PeriodButton>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : allEmpty ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            No successful requests in this period
          </div>
        ) : (
          <ChartContainer config={LATENCY_CHART_CONFIG} className="aspect-auto h-64 w-full">
            <LineChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.2} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
              <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${v}ms`} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Line dataKey="p50" type="monotone" stroke="var(--color-p50)" strokeWidth={2} dot={false} connectNulls={false} />
              <Line dataKey="p95" type="monotone" stroke="var(--color-p95)" strokeWidth={2} dot={false} connectNulls={false} />
              <Line dataKey="p99" type="monotone" stroke="var(--color-p99)" strokeWidth={2} dot={false} connectNulls={false} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function PeriodButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-3 py-1 rounded text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
