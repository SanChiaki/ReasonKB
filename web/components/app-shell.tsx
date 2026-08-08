"use client";

import React, { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { SidebarNav, type SidebarConversation } from "@/components/sidebar-nav";
import { I18nProvider, useI18n } from "@/lib/i18n";

export function AppShell({
  conversations,
  children,
  admin = false,
}: {
  conversations: SidebarConversation[];
  children: ReactNode;
  admin?: boolean;
}) {
  return (
    <I18nProvider>
      <AppShellContent conversations={conversations} admin={admin}>
        {children}
      </AppShellContent>
    </I18nProvider>
  );
}

function AppShellContent({
  conversations,
  children,
  admin,
}: {
  conversations: SidebarConversation[];
  children: ReactNode;
  admin: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { t } = useI18n();

  async function logoutAdmin() {
    const match = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("reasonkb_admin_csrf="));
    const csrf = match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
    await fetch("/api/admin/auth/logout", {
      method: "POST",
      headers: { "x-reasonkb-csrf": csrf },
    });
    window.location.assign("/admin/login");
  }

  return (
    <div className="h-dvh overflow-hidden bg-[var(--pi-bg)] md:flex">
      <SidebarNav
        mobileOpen={mobileOpen}
        conversations={conversations}
        admin={admin}
        onCloseMobile={() => setMobileOpen(false)}
        onAdminLogout={logoutAdmin}
      />
      {mobileOpen ? (
        <button
          type="button"
          aria-label={t("nav.close")}
          className="fixed inset-0 z-30 bg-[rgba(24,31,44,0.26)] md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center border-b border-[var(--pi-border)] bg-[var(--pi-panel)] px-4 md:hidden">
          <button
            type="button"
            aria-label={t("nav.open")}
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)]"
          >
            <Menu aria-hidden="true" size={18} />
          </button>
          <div className="ml-3">
            <p className="text-sm font-semibold text-[var(--pi-ink)]">ReasonKB</p>
            <p className="text-[11px] text-[var(--pi-muted)]">{t("app.subtitle")}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
