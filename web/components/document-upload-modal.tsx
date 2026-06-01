"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

type UploadResult = {
  uploaded: Array<{ fileName: string }>;
  failed: Array<{ fileName: string; error: string }>;
};

export function DocumentUploadModal({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<UploadResult | null>(null);

  function resetSelection() {
    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedFiles.length === 0) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setResultSummary(null);

    const formData = new FormData();
    for (const file of selectedFiles) {
      formData.append("files", file);
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/documents/upload`, {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as
        | ({ error?: string } & UploadResult)
        | null;
      const uploaded = payload?.uploaded ?? [];
      const failed = payload?.failed ?? [];

      if (uploaded.length > 0) {
        router.refresh();
      }

      if (!response.ok && uploaded.length === 0) {
        setErrorMessage(payload?.error ?? t("documents.uploadError"));
        setResultSummary({ uploaded, failed });
        return;
      }

      if (failed.length > 0) {
        setResultSummary({ uploaded, failed });
        resetSelection();
        return;
      }

      setIsOpen(false);
      resetSelection();
    } catch {
      setErrorMessage(t("documents.uploadError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  const modalContent = isOpen ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(23,32,51,0.28)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-upload-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-[var(--pi-border)] bg-[var(--pi-panel-strong)] p-6 shadow-[0_30px_70px_rgba(65,88,130,0.2)]"
      >
        <h2 id="document-upload-title" className="text-xl font-semibold text-[var(--pi-ink)]">
          {t("documents.uploadTitle")}
        </h2>
        <p className="mt-2 text-sm text-[var(--pi-muted)]">
          {t("documents.uploadDescription")}
        </p>

        <div className="mt-5 rounded-lg border border-dashed border-[var(--pi-border)] bg-[var(--pi-bg)] p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            multiple
            className="hidden"
            onChange={(event) => {
              setSelectedFiles(Array.from(event.target.files ?? []));
              setErrorMessage(null);
              setResultSummary(null);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-[var(--pi-border)] bg-white px-3 py-2 text-sm text-[var(--pi-ink)] transition hover:border-[var(--pi-border-strong)]"
          >
            {t("documents.chooseFiles")}
          </button>
          <p className="mt-3 text-xs text-[var(--pi-muted)]">
            {selectedFiles.length === 0
              ? t("documents.noneSelected")
              : t("documents.filesSelected", {
                  count: selectedFiles.length,
                  plural: selectedFiles.length === 1 ? "" : "s",
                })}
          </p>
          {selectedFiles.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-[var(--pi-ink)]">
              {selectedFiles.map((file) => (
                <li key={`${file.name}-${file.size}`}>{file.name}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {errorMessage ? (
          <p className="mt-4 rounded-md border border-[rgba(180,35,24,0.24)] bg-[rgba(254,242,242,0.88)] px-3 py-2 text-sm text-[var(--pi-danger)]">
            {errorMessage}
          </p>
        ) : null}
        {resultSummary ? (
          <div className="mt-4 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] px-3 py-3 text-sm text-[var(--pi-ink)]">
            <p>
              {t("documents.uploadSummary", {
                uploaded: resultSummary.uploaded.length,
                failed: resultSummary.failed.length,
              })}
            </p>
            {resultSummary.failed.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-[var(--pi-danger)]">
                {resultSummary.failed.map((item) => (
                  <li key={`${item.fileName}-${item.error}`}>
                    <span className="font-medium text-[var(--pi-ink)]">{item.fileName}</span>
                    {`: ${item.error}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setErrorMessage(null);
              setResultSummary(null);
              resetSelection();
            }}
            className="rounded-md border border-[var(--pi-border)] px-3.5 py-2 text-sm text-[var(--pi-muted)] transition hover:border-[var(--pi-border-strong)] hover:text-[var(--pi-ink)]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={selectedFiles.length === 0 || isSubmitting}
            className="rounded-md border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? t("documents.uploading") : t("documents.uploadFiles")}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
      >
        {t("documents.upload")}
      </button>
      {modalContent && typeof document !== "undefined"
        ? createPortal(modalContent, document.body)
        : null}
    </>
  );
}
