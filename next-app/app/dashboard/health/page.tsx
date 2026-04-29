"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface HealthData {
  tokenExpiry: string | null;
  lastRefresh: string | null;
  nextRefresh: string | null;
  status: "active" | "expiring-soon" | "expired";
}

export default function HealthPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = () => {
    fetch("/api/health")
      .then((res) => res.json())
      .then(setHealth)
      .catch(console.error);
  };

  const triggerRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/claude/oauth/refresh", { method: "POST" });
      fetchHealth();
    } catch (e) {
      console.error(e);
    }
    setRefreshing(false);
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  const formatCountdown = (expiryDate: string | null) => {
    if (!expiryDate) return "Unknown";
    const diff = new Date(expiryDate).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    return `${days}d ${hours}h`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Health</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Token Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge
              variant={
                health?.status === "active" ? "default" : health?.status === "expiring-soon" ? "secondary" : "destructive"
              }
            >
              {health?.status ?? "unknown"}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Token Expires In</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCountdown(health?.tokenExpiry ?? null)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last Refresh</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">{health?.lastRefresh ? new Date(health.lastRefresh).toLocaleString() : "Never"}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Next Scheduled Refresh</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">{health?.nextRefresh ? new Date(health.nextRefresh).toLocaleString() : "Unknown"}</div>
          </CardContent>
        </Card>
      </div>

      <Button onClick={triggerRefresh} disabled={refreshing}>
        {refreshing ? "Refreshing..." : "Refresh Token Now"}
      </Button>
    </div>
  );
}