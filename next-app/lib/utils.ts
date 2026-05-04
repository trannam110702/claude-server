import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// cs_xxxxxxxxxxxxxxxxxxxxxxxx -> cs_xxxxxxxx•••••••• (preserve prefix, mask rest)
export function maskedSecret(secret: string): string {
  if (!secret) return "";
  const head = secret.slice(0, 11);
  return `${head}${"•".repeat(Math.max(8, Math.min(24, secret.length - 11)))}`;
}
