"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  Database,
  Folder,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  Plus,
  ScrollText,
  Settings,
} from "lucide-react";
import { ChatHistoryList } from "@/components/chat-history-list";
import { useI18n } from "@/lib/i18n";

export type SidebarConversation = {
  id: string;
  title: string;
  scopeLabel: string;
  updatedAt?: string;
};

export function SidebarNav({
  mobileOpen,
  conversations,
  admin = false,
  onCloseMobile,
  onAdminLogout,
}: {
  mobileOpen: boolean;
  conversations: SidebarConversation[];
  admin?: boolean;
  onCloseMobile: () => void;
  onAdminLogout?: () => void | Promise<void>;
}) {
  const pathname = usePathname();
  const { t } = useI18n();

  function isActivePath(href: string) {
    return pathname === href || Boolean(pathname?.startsWith(`${href}/`));
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-[var(--pi-sidebar-width)] shrink-0 flex-col border-r border-[var(--pi-border)] bg-[var(--pi-panel)] transition-transform duration-200 md:static md:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--pi-border)] px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--pi-ink)] text-xs font-semibold text-white">
              RK
            </div>
            <div>
              <p className="text-base font-semibold text-[var(--pi-ink)]">ReasonKB</p>
              <p className="text-xs text-[var(--pi-muted)]">{t("app.subtitle")}</p>
            </div>
            <button
              type="button"
              aria-label={t("nav.close")}
              onClick={onCloseMobile}
              className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pi-border)] text-[var(--pi-muted)] transition hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)] md:hidden"
            >
              <PanelLeftClose aria-hidden="true" size={16} />
            </button>
          </div>
          {!admin ? (
            <Link
              href="/chat"
              onClick={onCloseMobile}
              className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-3 text-sm font-medium text-white transition hover:bg-[#1556d9]"
            >
              <Plus aria-hidden="true" size={16} />
              {t("nav.newChat")}
            </Link>
          ) : null}
        </div>

        <nav className="border-b border-[var(--pi-border)] px-3 py-3">
          <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase text-[var(--pi-muted)]">
            {t("nav.workspace")}
          </p>
          <Link
            href="/chat"
            onClick={onCloseMobile}
            aria-current={isActivePath("/chat") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
              isActivePath("/chat")
                ? "bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <MessageSquare aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.chat")}
          </Link>
          <Link
            href="/projects"
            onClick={onCloseMobile}
            aria-current={isActivePath("/projects") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              isActivePath("/projects")
                ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <Folder aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.projects")}
          </Link>
          <p className="mt-4 px-2 pb-1.5 text-[10px] font-semibold uppercase text-[var(--pi-muted)]">
            {t("nav.management")}
          </p>
          <Link
            href="/admin/status"
            onClick={onCloseMobile}
            aria-current={isActivePath("/admin/status") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              isActivePath("/admin/status")
                ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <Activity aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.status")}
          </Link>
          <Link
            href="/admin/audit"
            onClick={onCloseMobile}
            aria-current={isActivePath("/admin/audit") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              isActivePath("/admin/audit")
                ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <ScrollText aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.audit")}
          </Link>
          <Link
            href="/admin/sources"
            onClick={onCloseMobile}
            aria-current={isActivePath("/admin/sources") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              isActivePath("/admin/sources")
                ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <Database aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.sources")}
          </Link>
          <Link
            href="/settings"
            onClick={onCloseMobile}
            aria-current={isActivePath("/settings") ? "page" : undefined}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
              isActivePath("/settings")
                ? "bg-[var(--pi-brand-soft)] font-medium text-[var(--pi-brand)]"
                : "text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <Settings aria-hidden="true" size={18} strokeWidth={2} />
            {t("nav.settings")}
          </Link>
        </nav>

        {!admin ? (
          <section className="flex min-h-0 flex-1 flex-col p-3">
            <h2 className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase text-[var(--pi-muted)]">
              {t("nav.recentChats")}
            </h2>
            <div className="rk-scrollbar flex-1 space-y-0.5 overflow-y-auto">
              <ChatHistoryList conversations={conversations} />
            </div>
          </section>
        ) : (
          <div className="min-h-0 flex-1" />
        )}

        {admin ? (
          <div className="border-t border-[var(--pi-border)] p-3">
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase text-[var(--pi-muted)]">
              {t("nav.adminView")}
            </p>
            <Link
              href="/chat"
              onClick={onCloseMobile}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--pi-muted)] transition hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            >
              <ArrowLeft aria-hidden="true" size={17} />
              {t("nav.backToWorkspace")}
            </Link>
            <button
              type="button"
              onClick={() => void onAdminLogout?.()}
              className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--pi-muted)] transition hover:bg-red-50 hover:text-[var(--pi-danger)]"
            >
              <LogOut aria-hidden="true" size={17} />
              {t("nav.logout")}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
