import { AppShell } from "@/components/app-shell";
import { ProjectGrid } from "@/components/project-grid";
import { appConfig } from "@/lib/config";
import { LocalizedSearchInput, LocalizedText } from "@/lib/i18n";
import { listConversations } from "@/lib/repos/conversation-store";
import { listProjects } from "@/lib/repos/project-store";

const demoUserId = "user_demo";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const rawQuery = (params.q ?? "").trim();
  const query = rawQuery.toLowerCase();
  const conversations = listConversations(appConfig.dbPath, demoUserId);
  const projects = listProjects(appConfig.dbPath);
  const visibleProjects = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects;

  return (
    <AppShell conversations={conversations}>
      <section className="rk-scrollbar h-full overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <header className="border-b border-[var(--pi-border)] pb-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
                <LocalizedText id="projects.eyebrow" />
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-[var(--pi-ink)] md:text-3xl">
                <LocalizedText id="projects.title" />
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
                <LocalizedText id="projects.description" />
              </p>
            </div>
          </div>
          <form className="mt-5">
            <LocalizedSearchInput
              id="project-search"
              name="q"
              defaultValue={params.q ?? ""}
              labelKey="projects.search"
              placeholderKey="projects.search"
              className="w-full rounded-md border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)] focus:ring-2 focus:ring-[var(--pi-brand-soft)]"
            />
          </form>
        </header>

        <div className="pt-6">
          <ProjectGrid projects={visibleProjects} searchQuery={rawQuery} />
        </div>
      </section>
    </AppShell>
  );
}
