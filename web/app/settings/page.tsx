import { AppShell } from "@/components/app-shell";
import { AdminPasswordForm } from "@/components/admin-password-form";
import { ApiKeyManager } from "@/components/api-key-manager";
import { EmbeddingSettingsPanel } from "@/components/embedding-settings-panel";
import { SystemSettingsForm } from "@/components/system-settings-form";
import { appConfig } from "@/lib/config";
import { LocalizedText } from "@/lib/i18n";
import { listApiKeys } from "@/lib/repos/api-key-store";
import { listProjects } from "@/lib/repos/project-store";
import { getSystemSettings } from "@/lib/repos/system-settings-store";
import { requireAdminPage } from "@/lib/security/admin-page-auth";
import { BrainCircuit, Database, Languages, ShieldCheck } from "lucide-react";

const adminOwnerId = "deployment-admin";

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
  embeddingApiKey:
    process.env.REASONKB_EMBEDDING_API_KEY ??
    process.env.EMBEDDING_API_KEY ??
    "",
  embeddingBaseUrl:
    process.env.REASONKB_EMBEDDING_BASE_URL ??
    process.env.EMBEDDING_BASE_URL ??
    "",
  embeddingModel:
    process.env.REASONKB_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL ?? "",
  projectsRootHostPath: appConfig.currentProjectsRootHostPath,
};

export default async function SettingsPage() {
  await requireAdminPage();
  const settings = getSystemSettings(appConfig.dbPath, defaults);
  const apiKeys = listApiKeys(appConfig.dbPath, adminOwnerId);
  const projects = listProjects(appConfig.dbPath).map((project) => ({
    id: project.id,
    name: project.name,
  }));

  return (
    <AppShell conversations={[]} admin>
      <section className="rk-scrollbar h-full overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <div className="mx-auto w-full max-w-[88rem]">
          <header className="border-b border-[var(--pi-border)] pb-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
              <LocalizedText id="settings.eyebrow" />
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-[var(--pi-ink)] md:text-3xl">
              <LocalizedText id="settings.title" />
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
              <LocalizedText id="settings.description" />
            </p>
          </header>

          <div className="grid gap-6 pt-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10">
            <nav
              aria-label="Settings sections"
              className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:sticky lg:top-0 lg:block lg:self-start"
            >
              {[
                {
                  href: "#settings-models",
                  icon: BrainCircuit,
                  label: "settings.navModels" as const,
                },
                {
                  href: "#settings-indexing",
                  icon: Database,
                  label: "settings.navIndexing" as const,
                },
                {
                  href: "#settings-interface",
                  icon: Languages,
                  label: "settings.navInterface" as const,
                },
                {
                  href: "#settings-access",
                  icon: ShieldCheck,
                  label: "settings.navAccess" as const,
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className="flex min-h-10 min-w-0 items-center gap-2.5 rounded-md px-3 text-sm font-medium text-[var(--pi-muted)] transition hover:bg-white hover:text-[var(--pi-ink)] lg:mb-1 lg:w-full"
                  >
                    <Icon aria-hidden="true" className="h-4 w-4" />
                    <LocalizedText id={item.label} />
                  </a>
                );
              })}
            </nav>

            <div className="min-w-0 space-y-6">
              <SystemSettingsForm
                embeddingSettings={
                  <EmbeddingSettingsPanel
                    embedded
                    initialApiKeyConfigured={settings.embeddingApiKeyConfigured}
                    initialApiKeyInherited={settings.embeddingApiKeyInherited}
                    initialBaseUrl={settings.embeddingBaseUrl}
                    initialBaseUrlInherited={settings.embeddingBaseUrlInherited}
                    initialModel={settings.embeddingModel}
                    semanticIndex={settings.semanticIndex}
                  />
                }
                initialIndexWorkerConcurrency={settings.indexWorkerConcurrency}
                initialRetrievalDocumentLimit={settings.retrievalDocumentLimit}
                initialLlmApiKeyConfigured={settings.llmApiKeyConfigured}
                initialLlmBaseUrl={settings.llmBaseUrl}
                initialLlmModel={settings.llmModel}
                initialLlmRetrievalModel={settings.llmRetrievalModel}
                initialLlmConfigured={settings.llmConfigured}
                initialLlmMissingFields={settings.llmMissingFields}
                initialCurrentProjectsRootHostPath={
                  settings.currentProjectsRootHostPath
                }
                initialPendingProjectsRootHostPath={
                  settings.pendingProjectsRootHostPath
                }
                initialProjectsRootSwitchStatus={
                  settings.projectsRootSwitchStatus
                }
                initialProjectsRootSwitchUpdatedAt={
                  settings.projectsRootSwitchUpdatedAt
                }
                projectsRootEnvFilePath={appConfig.envFilePath}
                projectsRootComposeCommand={appConfig.composeCommand}
                projectsRootBrowseRootHostPath={
                  appConfig.hostBrowseRootHostPath
                }
                projectsRootPickerAvailable={
                  Boolean(appConfig.hostBrowseRootHostPath) &&
                  Boolean(appConfig.hostBrowseRootContainerPath)
                }
                corpusSource={appConfig.corpusSource}
                smbCorpusTarget={appConfig.smbCorpusTarget}
              />

              <section id="settings-access" className="scroll-mt-6 space-y-5">
                <header className="border-b border-[var(--pi-border)] pb-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
                    <LocalizedText id="settings.accessEyebrow" />
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
                    <LocalizedText id="settings.accessTitle" />
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
                    <LocalizedText id="settings.accessDescription" />
                  </p>
                </header>
                <ApiKeyManager initialApiKeys={apiKeys} projects={projects} />
                <AdminPasswordForm />
              </section>
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
