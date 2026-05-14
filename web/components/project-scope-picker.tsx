"use client";

import React from "react";

export function ProjectScopePicker({
  projects,
  selectedProjectIds,
  onToggle,
}: {
  projects: Array<{ id: string; name: string }>;
  selectedProjectIds: string[];
  onToggle: (projectId: string) => void;
}) {
  if (projects.length === 0) {
    return (
      <p className="text-xs text-[var(--pi-muted)]">
        No projects yet. Retrieval will use all ready documents once they are indexed.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-md border border-[var(--pi-border)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--pi-muted)]">
        {selectedProjectIds.length === 0 ? "All projects" : "Filtered"}
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
            {project.name}
          </button>
        );
      })}
    </div>
  );
}
