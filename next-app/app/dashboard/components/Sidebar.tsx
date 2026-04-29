"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, BarChart3, FileText, HeartPulse, KeyRound, LogOut, Users } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { BRAND } from "@/lib/branding";

const navItems = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/accounts", label: "Accounts", icon: Users },
  { href: "/dashboard/tokens", label: "API tokens", icon: KeyRound },
  { href: "/dashboard/usage", label: "Usage", icon: BarChart3 },
  { href: "/dashboard/logs", label: "Logs", icon: FileText },
  { href: "/dashboard/health", label: "Health", icon: HeartPulse },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <aside className="flex w-64 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <div>
          <h1 className="text-base font-semibold">{BRAND.name}</h1>
          <p className="text-xs text-muted-foreground">{BRAND.tagline}</p>
        </div>
        <ModeToggle />
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === item.href
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {session?.user && (
        <div className="border-t p-3">
          <div className="mb-2 px-1 text-xs">
            <div className="truncate font-medium">{session.user.name}</div>
            <div className="truncate text-muted-foreground">{session.user.email}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      )}
    </aside>
  );
}
