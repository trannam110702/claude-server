"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  code: string;
  language?: "json" | "bash";
  className?: string;
};

export function SnippetBlock({ code, language = "bash", className }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in non-secure contexts; silently ignore.
    }
  };

  return (
    <div className={cn("relative", className)}>
      <pre
        className="overflow-x-auto rounded-md border bg-muted p-4 pr-12 text-xs leading-relaxed"
        data-language={language}
      >
        <code className="font-mono">{code}</code>
      </pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute right-2 top-2 h-7 w-7"
        onClick={onCopy}
        aria-label="Copy snippet"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
