"use client";

import React from "react";
import { ProjectCard, type ProjectCardItem } from "@/components/project-card";
import { useI18n } from "@/lib/i18n";

export function ProjectGrid({
  projects,
  searchQuery,
}: {
  projects: ProjectCardItem[];
  searchQuery?: string;
}) {
  const { t } = useI18n();
  const trimmedSearchQuery = searchQuery?.trim() ?? "";

  if (projects.length === 0) {
    if (trimmedSearchQuery) {
      return (
        <section className="rounded-lg border border-dashed border-[var(--pi-border)] bg-white p-10 text-center">
          <h2 className="text-xl font-semibold text-[var(--pi-ink)]">
            {t("projects.noMatchesTitle")}
          </h2>
          <p className="mt-2 text-sm text-[var(--pi-muted)]">
            {t("projects.noMatchesDescription", { query: trimmedSearchQuery })}
          </p>
        </section>
      );
    }

    return (
      <section className="rounded-lg border border-dashed border-[var(--pi-border)] bg-white p-10 text-center">
        <h2 className="text-xl font-semibold text-[var(--pi-ink)]">
          {t("projects.emptyTitle")}
        </h2>
        <p className="mt-2 text-sm text-[var(--pi-muted)]">
          {t("projects.emptyDescription")}
        </p>
      </section>
    );
  }

  return (
    <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </section>
  );
}
