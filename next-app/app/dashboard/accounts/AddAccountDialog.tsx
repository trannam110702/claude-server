"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Copy, ExternalLink } from "lucide-react";

type Step = "connect" | "exchanging" | "success" | "error";

interface AuthData {
  authUrl: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  manual: boolean;
}

interface ConnectedAccount {
  id: string;
  name: string;
  email: string | null;
}

export function AddAccountDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<Step>("connect");
  const [authData, setAuthData] = useState<AuthData | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [connectedAccount, setConnectedAccount] = useState<ConnectedAccount | null>(null);
  const popupRef = useRef<Window | null>(null);
  const processedRef = useRef(false);
  // Guards against React 18 strict-mode double-invoke firing /authorize twice.
  const startedRef = useRef(false);

  const reset = () => {
    setStep("connect");
    setAuthData(null);
    setCallbackUrl("");
    setError(null);
    setCopied(false);
    setPopupOpen(false);
    setConnectedAccount(null);
    processedRef.current = false;
    startedRef.current = false;
    if (popupRef.current && !popupRef.current.closed) {
      try { popupRef.current.close(); } catch {}
    }
    popupRef.current = null;
  };

  const exchange = useCallback(
    async (code: string, state: string | null, data: AuthData) => {
      if (processedRef.current) return;
      processedRef.current = true;
      setStep("exchanging");
      setError(null);
      try {
        const res = await fetch("/api/claude/oauth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            state,
            redirectUri: data.redirectUri,
            codeVerifier: data.codeVerifier,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Exchange failed");
        setConnectedAccount(json.account || null);
        setStep("success");
        onAdded();
      } catch (err) {
        setError((err as Error).message);
        setStep("error");
        processedRef.current = false;
      }
    },
    [onAdded]
  );

  // Server-side polling: ask /api/claude/oauth/poll?state=… for the code.
  // Claude redirects to /callback regardless of which Chrome profile completed
  // the authorization, the server records it under `state`, and we pick it up
  // here. This works across browser profiles because coordination is server-
  // side, not browser-side. Stops on success/error/dialog-close/5min timeout.
  useEffect(() => {
    if (!authData || authData.manual) return;
    let cancelled = false;
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;

    const tick = async () => {
      if (cancelled || processedRef.current) return;
      if (Date.now() - startedAt > TIMEOUT_MS) {
        cancelled = true;
        setError("Authorization timed out (5 minutes).");
        setStep("error");
        return;
      }
      try {
        const res = await fetch(
          `/api/claude/oauth/poll?state=${encodeURIComponent(authData.state)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.error) {
          cancelled = true;
          setError(data.errorDescription || data.error);
          setStep("error");
          return;
        }
        if (data.code) {
          cancelled = true;
          exchange(data.code, data.state || null, authData);
          return;
        }
      } catch {
        // network blip, keep polling
      }
      if (!cancelled) setTimeout(tick, 1500);
    };
    tick();

    return () => {
      cancelled = true;
    };
  }, [authData, exchange]);

  const startFlow = useCallback(async () => {
    try {
      setError(null);
      setStep("connect");
      // Anthropic's OAuth client only whitelists localhost/* and the OOB
      // console URL. On any other origin, redirecting back to /callback
      // returns "Redirect URI ... is not supported by client", so fall
      // back to the OOB flow and let the user paste the code.
      const isLocal = /^(localhost$|127\.|\[?::1\]?$)/i.test(window.location.hostname);
      const redirectUri = isLocal
        ? `${window.location.origin}/callback`
        : "https://console.anthropic.com/oauth/code/callback";
      const res = await fetch(
        `/api/claude/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start OAuth");
      setAuthData({
        authUrl: data.authUrl,
        codeVerifier: data.codeVerifier,
        state: data.state,
        redirectUri,
        manual: !isLocal,
      });
    } catch (err) {
      setError((err as Error).message);
      setStep("error");
    }
  }, []);

  // Auto-start the OAuth flow when the dialog opens — no name prompt up front.
  // The ref guard prevents React 18 strict-mode double-invoke from firing
  // /authorize twice (which would generate two PKCE states and break polling).
  useEffect(() => {
    if (open && !authData && step === "connect" && !startedRef.current) {
      startedRef.current = true;
      startFlow();
    }
  }, [open, authData, step, startFlow]);

  const copyUrl = async () => {
    if (!authData) return;
    try {
      await navigator.clipboard.writeText(authData.authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const openPopup = () => {
    if (!authData) return;
    popupRef.current = window.open(authData.authUrl, "claude_oauth", "width=600,height=750");
    setPopupOpen(!!popupRef.current);
  };

  const submitManual = () => {
    if (!authData) return;
    const trimmed = callbackUrl.trim();
    if (!trimmed) return;
    try {
      // Accept either a full callback URL or a bare code string (Claude's
      // copy-the-code page returns "<code>#<state>"). Try URL parse first.
      let code: string | null = null;
      let state: string | null = null;
      if (/^https?:\/\//i.test(trimmed)) {
        const url = new URL(trimmed);
        const errParam = url.searchParams.get("error");
        if (errParam) {
          setError(url.searchParams.get("error_description") || errParam);
          setStep("error");
          return;
        }
        code = url.searchParams.get("code");
        state = url.searchParams.get("state");
      } else {
        code = trimmed; // bare code, possibly "abc#state"
      }
      if (!code) throw new Error("No code found in input");
      exchange(code, state, authData);
    } catch (err) {
      setError((err as Error).message);
      setStep("error");
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Claude account</DialogTitle>
        </DialogHeader>

        {step === "connect" && !authData && (
          <div className="text-center py-6 text-sm text-muted-foreground">
            Preparing authorization URL…
          </div>
        )}

        {step === "connect" && authData && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Authorize URL</Label>
              <div className="flex gap-2">
                <Input value={authData.authUrl} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copyUrl}
                  aria-label="Copy URL"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {authData.manual
                  ? "Open this URL in the Chrome profile that's signed in to the Claude account you want to add. After you authorize, Anthropic will display a code — copy it and paste it below."
                  : "Open this URL in the Chrome profile that's signed in to the Claude account you want to add. Once you authorize, this dialog will pick up the result automatically — no copy-paste back."}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(authData.authUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open in new tab
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openPopup}
                  disabled={popupOpen}
                >
                  {popupOpen ? "Popup open" : "Open in popup"}
                </Button>
              </div>
            </div>

            {authData.manual ? (
              <div className="space-y-2">
                <Label>Paste the code from Anthropic</Label>
                <Input
                  placeholder="Paste code (looks like abc…#state)"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  onClick={submitManual}
                  disabled={!callbackUrl.trim()}
                >
                  Connect with pasted code
                </Button>
              </div>
            ) : (
              <>
                <div className="rounded-md bg-muted/50 p-3 text-sm flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-muted-foreground">
                    Waiting for authorization…
                  </span>
                </div>

                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Auto-pickup not working? Paste manually</summary>
                  <div className="space-y-2 pt-3">
                    <Input
                      placeholder="Paste callback URL or code"
                      value={callbackUrl}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      className="font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={submitManual}
                      disabled={!callbackUrl.trim()}
                    >
                      Connect with pasted code
                    </Button>
                  </div>
                </details>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "exchanging" && (
          <div className="text-center py-6 text-sm">Exchanging tokens…</div>
        )}

        {step === "success" && (
          <div className="text-center py-6 space-y-3">
            <p className="font-medium">Account connected</p>
            {connectedAccount?.email ? (
              <p className="text-sm text-muted-foreground">
                Signed in as <span className="font-mono">{connectedAccount.email}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Token saved. You can rename it from the account list.
              </p>
            )}
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        )}

        {step === "error" && (
          <div className="space-y-4">
            <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error || "Something went wrong."}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => reset()}>Try again</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
