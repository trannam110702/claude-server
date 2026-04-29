"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface UsageData {
  requestsToday: number;
  tokensUsed: number;
  model: string;
}

export default function UsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(60);

  const fetchUsage = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/stats");
      const data = await res.json();
      setUsage({
        requestsToday: data.requestsToday,
        tokensUsed: data.tokensUsed || 0,
        model: data.model || "claude",
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(() => {
      setCountdown((c) => (c <= 1 ? 60 : c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const refreshInterval = setInterval(fetchUsage, 60000);
    return () => clearInterval(refreshInterval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Usage</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Auto-refresh in {countdown}s</span>
          <Button variant="outline" size="sm" onClick={fetchUsage} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Requests Today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{usage?.requestsToday ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Model</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary">{usage?.model ?? "claude"}</Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}