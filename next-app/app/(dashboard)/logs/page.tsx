"use client";

import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface LogEntry {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  model?: string;
  error?: string;
}

interface LogsResponse {
  rows: LogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [endpointFilter, setEndpointFilter] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (endpointFilter) params.set("endpoint", endpointFilter);
    fetch(`/api/logs?${params}`)
      .then((res) => res.json())
      .then(setLogs)
      .catch(console.error);
  }, [page, endpointFilter]);

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Request Logs</h1>

      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center gap-4">
            <Input
              placeholder="Filter by endpoint..."
              value={endpointFilter}
              onChange={(e) => {
                setEndpointFilter(e.target.value);
                setPage(1);
              }}
              className="max-w-xs"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Model</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs?.rows.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs">{formatTime(log.timestamp)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{log.method}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{log.path}</TableCell>
                  <TableCell>
                    <Badge variant={log.status < 400 ? "default" : "destructive"}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{log.latency_ms}ms</TableCell>
                  <TableCell>{log.model ?? "-"}</TableCell>
                </TableRow>
              ))}
              {(!logs?.rows || logs.rows.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No logs found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between mt-4">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {logs?.totalPages || 1}
            </span>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= (logs?.totalPages || 1)}>
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}