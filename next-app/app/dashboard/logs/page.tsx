"use client";

import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface LogEntry {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  model?: string | null;
  error?: string | null;
  account_id?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  tokens_used?: number | null;
  stream?: number | null;
  user_token_id?: string | null;
  user_email?: string | null;
}

interface LogsResponse {
  rows: LogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [endpointFilter, setEndpointFilter] = useState("");
  const [selected, setSelected] = useState<LogEntry | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (endpointFilter) params.set("endpoint", endpointFilter);
    fetch(`/api/logs?${params}`)
      .then((res) => res.json())
      .then(setLogs)
      .catch(console.error);
  }, [page, endpointFilter]);

  const formatTime = (timestamp: string) => new Date(timestamp).toLocaleString();

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
                <TableHead>User</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs?.rows.map((log) => (
                <TableRow
                  key={log.id}
                  onClick={() => setSelected(log)}
                  className="cursor-pointer"
                >
                  <TableCell className="text-xs">{formatTime(log.timestamp)}</TableCell>
                  <TableCell className="text-xs">{fmt(log.user_email)}</TableCell>
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
                  <TableCell className="text-xs">
                    {log.account_name ? (
                      <span title={log.account_email || log.account_id || ""}>
                        {log.account_name}
                      </span>
                    ) : log.account_id ? (
                      <span className="text-muted-foreground" title={log.account_id}>
                        {log.account_id.slice(0, 8)}…
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{fmt(log.model)}</TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {log.tokens_used != null ? log.tokens_used : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {(!logs?.rows || logs.rows.length === 0) && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
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

      <LogDetailDialog log={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function LogDetailDialog({ log, onClose }: { log: LogEntry | null; onClose: () => void }) {
  return (
    <Dialog open={!!log} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Request #{log?.id}</DialogTitle>
        </DialogHeader>
        {log && (
          <div className="space-y-2 text-sm">
            <Field label="Time" value={new Date(log.timestamp).toLocaleString()} />
            <Field label="Method" value={log.method} />
            <Field label="Endpoint" value={log.path} mono />
            <Field
              label="Status"
              value={
                <Badge variant={log.status < 400 ? "default" : "destructive"}>{log.status}</Badge>
              }
            />
            <Field label="Latency" value={`${log.latency_ms} ms`} />
            <Field label="Stream" value={log.stream ? "yes" : "no"} />
            <hr className="my-2" />
            <Field label="Caller (user)" value={fmt(log.user_email)} />
            {log.user_token_id && <Field label="API token id" value={log.user_token_id} mono />}
            <hr className="my-2" />
            <Field label="Account" value={log.account_name || fmt(log.account_id)} />
            {log.account_email && <Field label="Account email" value={log.account_email} />}
            {log.account_id && <Field label="Account ID" value={log.account_id} mono />}
            <hr className="my-2" />
            <Field label="Model" value={fmt(log.model)} mono />
            <Field label="Input tokens" value={log.input_tokens != null ? log.input_tokens.toLocaleString() : "—"} />
            <Field label="Output tokens" value={log.output_tokens != null ? log.output_tokens.toLocaleString() : "—"} />
            <Field label="Total tokens" value={log.tokens_used != null ? log.tokens_used.toLocaleString() : "—"} />
            {log.error && (
              <>
                <hr className="my-2" />
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Error</div>
                  <pre className="rounded bg-destructive/10 p-2 text-xs text-destructive whitespace-pre-wrap break-words">
                    {log.error}
                  </pre>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground self-center">{label}</div>
      <div className={mono ? "font-mono text-xs break-all" : "text-sm break-words"}>{value}</div>
    </div>
  );
}
