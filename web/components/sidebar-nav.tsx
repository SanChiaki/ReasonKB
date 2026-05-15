"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Folder, MessageSquare, PanelLeftClose, Settings, Plus } from "lucide-react";
import { ChatHistoryList } from "@/components/chat-history-list";

export type SidebarConversation = {
  id: string;
  title: string;
  scopeLabel: string;
  updatedAt?: string;
};

export function SidebarNav({
  mobileOpen,
  conversations,
  onCloseMobile,
}: {
  mobileOpen: boolean;
  conversations: SidebarConversation[];
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();

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
        <div className="border-b border-[var(--pi-border)] p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--pi-brand)] text-base font-semibold tracking-[-0.02em] text-white">
              RK
            </div>
            <div>
              <p className="text-base font-semibold text-[var(--pi-ink)]">ReasonKB</p>
              <p className="text-xs text-[var(--pi-muted)]">Knowledge Workspace</p>
            </div>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onCloseMobile}
              className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--pi-border)] text-[var(--pi-muted)] transition hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)] md:hidden"
            >
              <PanelLeftClose aria-hidden="true" size={16} />
            </button>
          </div>
          <Link
            href="/chat"
            onClick={onCloseMobile}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
          >
            <Plus aria-hidden="true" size={16} />
            New Chat
          </Link>
        </div>

        <nav className="space-y-1 border-b border-[var(--pi-border)] p-3">
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
            Chat
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
            Projects
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
            Settings
          </Link>
        </nav>

        <section className="flex min-h-0 flex-1 flex-col p-3">
          <h2 className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
            Recent Chats
          </h2>
          <div className="rk-scrollbar flex-1 space-y-0.5 overflow-y-auto">
            <ChatHistoryList conversations={conversations} />
          </div>
        </section>
      </div>
    </aside>
  );
}
