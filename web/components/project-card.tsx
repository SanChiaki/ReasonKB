"use client";

import React from "react";
import { useI18n, type Locale } from "@/lib/i18n";

function formatUpdatedAt(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export type ProjectCardItem = {
  id: string;
  name: string;
  documentCount: number;
  updatedAt: string;
  source: {
    id: string;
    displayName: string;
    kind: "local" | "smb" | "seeyon";
  };
};

export function ProjectCard({ project }: { project: ProjectCardItem }) {
  const { locale, t } = useI18n();
  const updatedAt = formatUpdatedAt(project.updatedAt, locale);

  return (
    <article className="rounded-lg border border-[var(--pi-border)] bg-white p-5 transition hover:border-[var(--pi-border-strong)] hover:shadow-[0_10px_26px_rgba(65,88,130,0.08)]">
      <a
        href={`/projects/${project.id}`}
        aria-label={t("projects.openAria", { name: project.name })}
        className="group block rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--pi-brand-soft)]"
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-semibold leading-tight text-[var(--pi-ink)] transition group-hover:text-[var(--pi-brand)]">
            {project.name}
          </h3>
          <span className="rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-1 text-xs font-medium uppercase text-[var(--pi-muted)]">
            {project.source.kind}
          </span>
        </div>
        <p className="mt-2 truncate text-xs text-[var(--pi-muted)]">
          {project.source.displayName}
        </p>
        <p className="mt-7 text-sm font-medium text-[var(--pi-ink)]">
          {t("projects.docs", { count: project.documentCount })}
        </p>
        <p className="mt-1 text-xs text-[var(--pi-muted)]">
          {updatedAt ? t("projects.updated", { date: updatedAt }) : t("projects.updatedRecently")}
        </p>
      </a>
    </article>
  );
}
