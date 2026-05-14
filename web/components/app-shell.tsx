"use client";

import React, { useState, type ReactNode } from "react";
import { SidebarNav, type SidebarConversation } from "@/components/sidebar-nav";

export function AppShell({
  conversations,
  children,
}: {
  conversations: SidebarConversation[];
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen overflow-hidden bg-[var(--pi-bg)] md:flex">
      <SidebarNav
        mobileOpen={mobileOpen}
        conversations={conversations}
        onCloseMobile={() => setMobileOpen(false)}
      />
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-[rgba(24,31,44,0.26)] md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main className="flex min-h-screen flex-1 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center border-b border-[var(--pi-border)] bg-[var(--pi-panel)] px-4 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pi-border)] bg-white text-[var(--pi-ink)]"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ☰
            </span>
          </button>
          <div className="ml-3">
            <p className="text-sm font-semibold text-[var(--pi-ink)]">ReasonKB</p>
            <p className="text-[11px] text-[var(--pi-muted)]">Knowledge Workspace</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
