import { AdminShell } from "@/components/admin-shell";
import { ModelProviderHealthPanel } from "@/components/model-provider-health-panel";
import { ServiceHealthPanel } from "@/components/service-health-panel";
import { LocalizedText } from "@/lib/i18n";
import { requireAdminPage } from "@/lib/security/admin-page-auth";

export const dynamic = "force-dynamic";

export default async function AdminStatusPage() {
  await requireAdminPage();

  return (
    <AdminShell>
      <header className="border-b border-[var(--pi-border)] pb-5">
        <p className="text-[11px] font-semibold uppercase text-[var(--pi-muted)]">
          <LocalizedText id="settings.serviceHealthEyebrow" />
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-[var(--pi-ink)]">
          <LocalizedText id="nav.status" />
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--pi-muted)]">
          <LocalizedText id="settings.statusPageDescription" />
        </p>
      </header>
      <div className="mt-5 space-y-5">
        <ServiceHealthPanel />
        <ModelProviderHealthPanel />
      </div>
    </AdminShell>
  );
}
