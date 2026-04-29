"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Overview", icon: "home" },
  { href: "/dashboard/oauth", label: "OAuth", icon: "key" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar-chart" },
  { href: "/dashboard/logs", label: "Logs", icon: "file-text" },
  { href: "/dashboard/health", label: "Health", icon: "heart-pulse" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r bg-card">
      <div className="p-4 border-b">
        <h1 className="text-lg font-semibold">Claude Server</h1>
        <p className="text-xs text-muted-foreground">Dashboard</p>
      </div>
      <nav className="p-2 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              )}
            >
              <span className="material-symbols-outlined text-lg">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}