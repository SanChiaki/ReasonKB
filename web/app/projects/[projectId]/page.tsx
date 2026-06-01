import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ProjectRenameControl } from "@/components/project-rename-control";
import { DocumentTable } from "@/components/document-table";
import { DocumentUploadModal } from "@/components/document-upload-modal";
import { appConfig } from "@/lib/config";
import { LocalizedSearchInput, LocalizedText } from "@/lib/i18n";
import { listConversations } from "@/lib/repos/conversation-store";
import { listDocumentsByProject } from "@/lib/repos/document-store";
import { getProjectById } from "@/lib/repos/project-store";

const demoUserId = "user_demo";

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  const rawQuery = (search.q ?? "").trim();
  const query = rawQuery.toLowerCase();
  const conversations = listConversations(appConfig.dbPath, demoUserId);
  const project = getProjectById(appConfig.dbPath, projectId, demoUserId);

  if (!project) {
    notFound();
  }

  const documents = listDocumentsByProject(appConfig.dbPath, projectId);
  const visibleDocuments = query
    ? documents.filter((document) =>
        document.fileName.toLowerCase().includes(query),
      )
    : documents;

  return (
    <AppShell conversations={conversations}>
      <section className="rk-scrollbar h-full overflow-y-auto px-5 py-6 md:px-8">
        <header className="border-b border-[var(--pi-border)] bg-transparent pb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
                <Link href="/projects" className="transition hover:text-[var(--pi-ink)]">
                  <LocalizedText id="projects.title" />
                </Link>
                <span>/</span>
                <span className="text-[var(--pi-ink)]">{project.name}</span>
              </div>
              <h1 className="mt-2 text-3xl font-semibold text-[var(--pi-ink)]">
                {project.name}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
                <LocalizedText id="projectDetail.description" />
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <ProjectRenameControl projectId={projectId} initialName={project.name} />
              <DocumentUploadModal projectId={projectId} />
            </div>
          </div>
          <form className="mt-6">
            <LocalizedSearchInput
              id="document-search"
              name="q"
              defaultValue={search.q ?? ""}
              labelKey="projectDetail.searchDocuments"
              placeholderKey="projectDetail.searchDocuments"
              className="w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
            />
          </form>
        </header>

        <div className="pt-6">
          <DocumentTable documents={visibleDocuments} searchQuery={rawQuery} />
        </div>
      </section>
    </AppShell>
  );
}
