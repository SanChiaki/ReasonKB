"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ChatHistoryList } from "@/components/chat-history-list";

export type SidebarConversation = {
  id: string;
  title: string;
  scopeLabel: string;
  updatedAt?: string;
};

export function SidebarNav({
  collapsed,
  conversations,
  onToggleCollapse,
}: {
  collapsed: boolean;
  conversations: SidebarConversation[];
  onToggleCollapse: () => void;
}) {
  const [themeMode, setThemeMode] = useState<"light" | "focus">("light");

  return (
    <aside
      className={`w-full rounded-b-[2rem] border border-[var(--pi-border)] bg-[rgba(255,255,255,0.78)] px-4 py-4 shadow-[0_24px_70px_rgba(65,88,130,0.14)] ring-1 ring-white/70 backdrop-blur-xl transition-[width] md:fixed md:inset-y-4 md:left-4 md:rounded-[2rem] md:px-3 md:py-4 ${
        collapsed ? "md:w-[5.75rem]" : "md:w-[17.5rem]"
      }`}
    >
      <div className="flex h-full flex-col">
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-[var(--pi-border)] bg-white/76 px-3 py-3 shadow-[0_10px_30px_rgba(65,88,130,0.08)]">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--pi-border-strong)] bg-[var(--pi-brand)] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(37,99,235,0.24)]">
            RK
          </div>
          {!collapsed ? (
            <div>
              <p className="text-sm font-semibold tracking-[0.02em] text-[var(--pi-ink)]">
                ReasonKB
              </p>
              <p className="text-xs text-[var(--pi-muted)]">Knowledge Workspace</p>
            </div>
          ) : null}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapse}
            className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--pi-border)] bg-[var(--pi-bg-soft)] text-[var(--pi-ink)] transition hover:border-[var(--pi-border-strong)] hover:bg-white"
          >
            <span aria-hidden="true" className="text-base leading-none">
              {collapsed ? "⟩" : "⟨"}
            </span>
          </button>
        </div>

        <nav className="space-y-2">
          <Link
            href="/chat"
            className={`flex rounded-2xl border border-[var(--pi-border-strong)] bg-[var(--pi-brand)] text-sm font-semibold text-white shadow-[0_14px_34px_rgba(37,99,235,0.24)] transition hover:-translate-y-0.5 hover:brightness-105 ${
              collapsed
                ? "items-center justify-center px-0 py-3"
                : "items-center justify-between px-4 py-3"
            }`}
          >
            {!collapsed ? <span>New Chat</span> : <span className="sr-only">New Chat</span>}
            <span className="text-base leading-none">+</span>
          </Link>
          <Link
            href="/projects"
            className={`block rounded-2xl border border-[var(--pi-border)] bg-white/64 text-sm text-[var(--pi-ink)] transition hover:border-[var(--pi-border-strong)] hover:bg-white ${
              collapsed ? "px-0 py-3 text-center" : "px-4 py-3"
            }`}
          >
            {collapsed ? "P" : "Projects"}
          </Link>
        </nav>

        <section className="mt-6 flex min-h-0 flex-1 flex-col">
          <h2
            className={`px-2 text-[11px] uppercase tracking-[0.16em] text-[var(--pi-muted)] ${
              collapsed ? "sr-only" : ""
            }`}
          >
            Chats
          </h2>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
            <ChatHistoryList conversations={conversations} collapsed={collapsed} />
          </div>
        </section>

        <footer
          aria-label="Sidebar controls"
          className="mt-auto border-t border-[var(--pi-border)] pt-4"
        >
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-label="Open settings"
              className="rounded-xl border border-[var(--pi-border)] bg-white/64 px-3 py-2 text-xs font-medium text-[var(--pi-ink)] transition hover:border-[var(--pi-border-strong)] hover:bg-white"
            >
              {collapsed ? "S" : "Settings"}
            </button>
            <button
              type="button"
              aria-label="Switch theme"
              aria-pressed={themeMode === "focus"}
              onClick={() =>
                setThemeMode((value) => (value === "light" ? "focus" : "light"))
              }
              className="rounded-xl border border-[var(--pi-border)] bg-white/64 px-3 py-2 text-xs font-medium text-[var(--pi-ink)] transition hover:border-[var(--pi-border-strong)] hover:bg-white"
            >
              {collapsed ? "T" : `Tone · ${themeMode === "light" ? "Light" : "Focus"}`}
            </button>
          </div>
        </footer>
      </div>
    </aside>
  );
}
