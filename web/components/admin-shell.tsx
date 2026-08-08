"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";

function csrfToken() {
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("reasonkb_admin_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <AppShell conversations={[]} admin>
      <main className="rk-scrollbar h-full overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <div className="mx-auto w-full max-w-[1480px]">{children}</div>
      </main>
    </AppShell>
  );
}

export function readAdminCsrfToken() {
  return csrfToken();
}
