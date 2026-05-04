"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserPlus } from "lucide-react";

interface UserRow {
  email: string;
  name: string | null;
  image: string | null;
  isAdmin: boolean;
  isSeedAdmin: boolean;
  isEnvAdmin: boolean;
  createdAt: string;
  lastLoginAt: string;
}

function relative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Pre-authorized rows have last_login_at === created_at; the moment they
// sign in, upsertUserOnLogin bumps last_login_at past created_at.
function neverSignedIn(u: UserRow): boolean {
  return u.lastLoginAt === u.createdAt && u.name === null;
}

export function UsersTable() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load users");
      setUsers(data.users);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggle(email: string, next: boolean) {
    setBusyEmail(email);
    setUsers((curr) =>
      curr.map((u) => (u.email === email ? { ...u, isAdmin: next } : u))
    );
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Toggle failed");
    } catch (err) {
      setUsers((curr) =>
        curr.map((u) => (u.email === email ? { ...u, isAdmin: !next } : u))
      );
      alert((err as Error).message);
    } finally {
      setBusyEmail(null);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.name ?? "").toLowerCase().includes(q)
    );
  }, [users, filter]);

  return (
    <>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between gap-2">
            <Input
              placeholder="Search by email or name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
            />
            <Button onClick={() => setAddOpen(true)} size="sm">
              <UserPlus className="mr-1.5 h-4 w-4" />
              Add user
            </Button>
          </div>

          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {!loading && !error && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Admin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      No users match.
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((u) => {
                  const locked = u.isSeedAdmin || u.isEnvAdmin;
                  const lockReason = u.isSeedAdmin
                    ? "Hardcoded in lib/admin.ts"
                    : "Set via ADMIN_EMAILS env var";
                  const pending = neverSignedIn(u);
                  return (
                    <TableRow key={u.email}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {u.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={u.image} alt="" className="h-8 w-8 rounded-full" />
                          ) : (
                            <div className="h-8 w-8 rounded-full bg-muted" />
                          )}
                          <div>
                            <div className="text-sm font-medium">{u.name || u.email}</div>
                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                              <span>{u.email}</span>
                              {u.isSeedAdmin && <Badge variant="secondary">seed admin</Badge>}
                              {u.isEnvAdmin && !u.isSeedAdmin && <Badge variant="secondary">env admin</Badge>}
                              {pending && <Badge variant="outline">invited</Badge>}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {pending ? "—" : relative(u.lastLoginAt)}
                      </TableCell>
                      <TableCell className="text-sm">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <div title={locked ? lockReason : undefined} className="inline-flex">
                          <Switch
                            checked={u.isAdmin || locked}
                            disabled={locked || busyEmail === u.email}
                            onCheckedChange={(next) => toggle(u.email, next)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
    </>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setEmail("");
    setIsAdmin(true);
    setSubmitting(false);
    setErr(null);
  }

  async function submit() {
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), isAdmin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add user");
      onAdded();
      reset();
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Pre-authorize a user before their first sign-in. Their name and
            avatar will fill in automatically the moment they sign in via
            Google.
          </p>
          <div className="space-y-2">
            <Label htmlFor="add-user-email">Email</Label>
            <Input
              id="add-user-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="add-user-admin" className="text-sm">Grant admin</Label>
              <p className="text-xs text-muted-foreground">
                If off, the user can sign in but cannot manage the dashboard.
              </p>
            </div>
            <Switch
              id="add-user-admin"
              checked={isAdmin}
              onCheckedChange={setIsAdmin}
            />
          </div>
          {err && (
            <p className="text-sm text-destructive">{err}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !email.trim()}>
            {submitting ? "Adding…" : "Add user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
