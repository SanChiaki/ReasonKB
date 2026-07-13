"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Database, LogOut, ScrollText, Settings } from "lucide-react";
import type { ReactNode } from "react";

function csrfToken() {
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("reasonkb_admin_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/admin/auth/logout", {
      method: "POST",
      headers: { "x-reasonkb-csrf": csrfToken() },
    });
    router.replace("/admin/login");
    router.refresh();
  }

  const links = [
    { href: "/admin/sources", label: "数据源", icon: Database },
    { href: "/admin/audit", label: "审计", icon: ScrollText },
    { href: "/settings", label: "系统设置", icon: Settings },
  ];

  return (
    <div className="min-h-dvh bg-[var(--pi-bg)] text-[var(--pi-ink)]">
      <header className="sticky top-0 z-30 border-b border-[var(--pi-border)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-[1440px] flex-wrap items-center gap-x-2 px-4 py-2 sm:h-14 sm:flex-nowrap sm:gap-5 sm:py-0 md:px-8">
          <Link
            href="/chat"
            className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-semibold"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--pi-brand)] text-xs text-white">
              RK
            </span>
            <span>ReasonKB 管理</span>
          </Link>
          <nav className="order-3 flex h-10 w-full items-center gap-1 overflow-x-auto sm:order-none sm:h-full sm:w-auto sm:overflow-visible">
            {links.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm transition ${
                    active
                      ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                      : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
                  }`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link
              href="/chat"
              title="返回知识库"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            >
              <ArrowLeft size={17} aria-hidden="true" />
            </Link>
            <button
              type="button"
              title="退出管理"
              onClick={logout}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-danger)]"
            >
              <LogOut size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}

export function readAdminCsrfToken() {
  return csrfToken();
}
