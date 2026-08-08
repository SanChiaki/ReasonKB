"use client";

import React from "react";
import { ArrowUpRight, Files } from "lucide-react";
import { DISPLAY_TIME_ZONE } from "@/lib/date-time";
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
    timeZone: DISPLAY_TIME_ZONE,
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
    <article className="transition hover:bg-[var(--pi-bg-soft)]">
      <a
        href={`/projects/${project.id}`}
        aria-label={t("projects.openAria", { name: project.name })}
        className="group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--pi-brand)] sm:grid-cols-[auto_minmax(0,1fr)_minmax(7rem,auto)_auto] sm:gap-5 sm:px-5"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-brand)]">
          <Files aria-hidden="true" size={17} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[var(--pi-ink)] transition group-hover:text-[var(--pi-brand)] sm:text-[15px]">
            {project.name}
          </span>
          <span className="mt-1 block truncate text-xs text-[var(--pi-muted)]">
            {project.source.displayName}
          </span>
        </span>
        <span className="hidden text-right sm:block">
          <span className="block text-sm font-medium text-[var(--pi-ink)]">
            {t("projects.docs", { count: project.documentCount })}
          </span>
          <span className="mt-1 block text-xs text-[var(--pi-muted)]">
            {updatedAt ? t("projects.updated", { date: updatedAt }) : t("projects.updatedRecently")}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[var(--pi-muted)]">
          <span className="hidden rounded-md border border-[var(--pi-border)] bg-white px-2 py-1 text-[10px] font-semibold uppercase sm:inline-block">
            {project.source.kind}
          </span>
          <ArrowUpRight aria-hidden="true" className="h-4 w-4 transition group-hover:text-[var(--pi-brand)]" />
        </span>
        <span className="col-start-2 text-xs text-[var(--pi-muted)] sm:hidden">
          {t("projects.docs", { count: project.documentCount })} · {updatedAt ? t("projects.updated", { date: updatedAt }) : t("projects.updatedRecently")}
        </span>
      </a>
    </article>
  );
}
