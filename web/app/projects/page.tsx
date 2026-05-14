import { AppShell } from "@/components/app-shell";
import { ProjectCreateForm } from "@/components/project-create-form";
import { ProjectGrid } from "@/components/project-grid";
import { appConfig } from "@/lib/config";
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
  const projects = listProjects(appConfig.dbPath, demoUserId);
  const visibleProjects = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects;

  return (
    <AppShell conversations={conversations}>
      <section className="rk-scrollbar h-full overflow-y-auto px-5 py-6 md:px-8">
        <header className="border-b border-[var(--pi-border)] bg-transparent pb-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-muted)]">
                Workspace
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-[var(--pi-ink)]">
                Projects
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[var(--pi-muted)] md:text-base">
                Organize documents by project, then search globally or filter chat by project.
              </p>
            </div>
            <ProjectCreateForm />
          </div>
          <form className="mt-5">
            <label htmlFor="project-search" className="sr-only">
              Search projects
            </label>
            <input
              id="project-search"
              name="q"
              type="search"
              defaultValue={params.q ?? ""}
              placeholder="Search projects"
              className="w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
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
