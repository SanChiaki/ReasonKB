"use client";

import React from "react";
import { useI18n } from "@/lib/i18n";

export function ProjectScopePicker({
  projects,
  selectedProjectIds,
  onToggle,
}: {
  projects: Array<{
    id: string;
    name: string;
    sourceDisplayName?: string;
    sourceKind?: "local" | "smb" | "seeyon";
  }>;
  selectedProjectIds: string[];
  onToggle: (projectId: string) => void;
}) {
  const { t } = useI18n();

  if (projects.length === 0) {
    return (
      <p className="text-xs text-[var(--pi-muted)]">
        {t("chat.noProjects")}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-md border border-[var(--pi-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--pi-muted)]">
        {selectedProjectIds.length === 0 ? t("scope.allProjects") : t("scope.filtered")}
      </span>
      {projects.map((project) => {
        const selected = selectedProjectIds.includes(project.id);
        return (
          <button
            key={project.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onToggle(project.id)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
              selected
                ? "border-[var(--pi-brand)] bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                : "border-[var(--pi-border)] bg-white text-[var(--pi-muted)] hover:bg-[var(--pi-bg)] hover:text-[var(--pi-ink)]"
            }`}
          >
            <span>{project.name}</span>
            {project.sourceDisplayName ? (
              <span className="ml-1 text-[10px] opacity-70">· {project.sourceDisplayName}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
