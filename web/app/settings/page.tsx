import { AppShell } from "@/components/app-shell";
import { SystemSettingsForm } from "@/components/system-settings-form";
import { appConfig } from "@/lib/config";
import { LocalizedText } from "@/lib/i18n";
import { listConversations } from "@/lib/repos/conversation-store";
import { getSystemSettings } from "@/lib/repos/system-settings-store";
import { requireAdminPage } from "@/lib/security/admin-page-auth";

const demoUserId = "user_demo";

export const dynamic = "force-dynamic";

const defaults = {
  indexWorkerConcurrency: Number.parseInt(
    process.env.INDEX_WORKER_CONCURRENCY ?? "1",
    10,
  ),
  retrievalDocumentLimit: 5,
  llmApiKey: process.env.PAGEINDEX_LLM_API_KEY ?? "",
  llmBaseUrl: process.env.PAGEINDEX_LLM_BASE_URL ?? "",
  llmModel: process.env.PAGEINDEX_LLM_MODEL ?? "openai/deepseek-v4-flash",
  llmRetrievalModel:
    process.env.PAGEINDEX_LLM_RETRIEVAL_MODEL ??
    process.env.PAGEINDEX_LLM_MODEL ??
    "openai/deepseek-v4-flash",
  projectsRootHostPath: appConfig.currentProjectsRootHostPath,
};

export default async function SettingsPage() {
  await requireAdminPage();
  const conversations = listConversations(appConfig.dbPath, demoUserId);
  const settings = getSystemSettings(appConfig.dbPath, defaults);

  return (
    <AppShell conversations={conversations}>
      <section className="rk-scrollbar h-full overflow-y-auto px-5 py-6 md:px-8">
        <header className="border-b border-[var(--pi-border)] bg-transparent pb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
            <LocalizedText id="settings.eyebrow" />
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-[var(--pi-ink)]">
            <LocalizedText id="settings.title" />
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
            <LocalizedText id="settings.description" />
          </p>
        </header>

        <div className="pt-6">
          <SystemSettingsForm
            initialIndexWorkerConcurrency={settings.indexWorkerConcurrency}
            initialRetrievalDocumentLimit={settings.retrievalDocumentLimit}
            initialLlmApiKeyConfigured={settings.llmApiKeyConfigured}
            initialLlmBaseUrl={settings.llmBaseUrl}
            initialLlmModel={settings.llmModel}
            initialLlmRetrievalModel={settings.llmRetrievalModel}
            initialLlmConfigured={settings.llmConfigured}
            initialLlmMissingFields={settings.llmMissingFields}
            initialCurrentProjectsRootHostPath={settings.currentProjectsRootHostPath}
            initialPendingProjectsRootHostPath={settings.pendingProjectsRootHostPath}
            initialProjectsRootSwitchStatus={settings.projectsRootSwitchStatus}
            initialProjectsRootSwitchUpdatedAt={settings.projectsRootSwitchUpdatedAt}
            projectsRootEnvFilePath={appConfig.envFilePath}
            projectsRootComposeCommand={appConfig.composeCommand}
            projectsRootBrowseRootHostPath={appConfig.hostBrowseRootHostPath}
            projectsRootPickerAvailable={
              Boolean(appConfig.hostBrowseRootHostPath) &&
              Boolean(appConfig.hostBrowseRootContainerPath)
            }
            corpusSource={appConfig.corpusSource}
            smbCorpusTarget={appConfig.smbCorpusTarget}
          />
        </div>
      </section>
    </AppShell>
  );
}
