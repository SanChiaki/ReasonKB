import { AppShell } from "@/components/app-shell";
import { SystemSettingsForm } from "@/components/system-settings-form";
import { appConfig } from "@/lib/config";
import { listConversations } from "@/lib/repos/conversation-store";
import { getSystemSettings } from "@/lib/repos/system-settings-store";

const demoUserId = "user_demo";

export const dynamic = "force-dynamic";

const defaults = {
  indexWorkerConcurrency: Number.parseInt(
    process.env.INDEX_WORKER_CONCURRENCY ?? "1",
    10,
  ),
};

export default async function SettingsPage() {
  const conversations = listConversations(appConfig.dbPath, demoUserId);
  const settings = getSystemSettings(appConfig.dbPath, defaults);

  return (
    <AppShell conversations={conversations}>
      <section className="space-y-8">
        <header className="rounded-[2rem] border border-[var(--pi-border)] bg-[var(--pi-panel)] px-6 py-7 shadow-[0_24px_70px_rgba(65,88,130,0.12)] ring-1 ring-white/70 backdrop-blur-xl md:px-8">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--pi-muted)]">
            Operations
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-[var(--pi-ink)] md:text-4xl">
            System settings
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
            Runtime controls stored in the application database and picked up by background services without a container restart.
          </p>
        </header>

        <SystemSettingsForm
          initialIndexWorkerConcurrency={settings.indexWorkerConcurrency}
        />
      </section>
    </AppShell>
  );
}
