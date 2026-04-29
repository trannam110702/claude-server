"use client";

import { useState, useEffect } from "react";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";

export function Toaster() {
  const [toasts, setToasts] = useState<Array<{ id: string; title?: string; description?: string }>>([]);

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      setToasts((prev) => [...prev, { id: crypto.randomUUID(), ...event.detail }]);
    };
    window.addEventListener("toast" as any, handler);
    return () => window.removeEventListener("toast" as any, handler);
  }, []);

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description }) => (
        <Toast key={id}>
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}