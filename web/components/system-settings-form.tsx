"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Folder, FolderOpen } from "lucide-react";

const SAVE_ERROR_MESSAGE = "Unable to save system settings. Please try again.";
const PROJECTS_ROOT_ERROR_MESSAGE =
  "Unable to prepare the projects root switch. Please try again.";
const HOST_DIRECTORIES_ERROR_MESSAGE =
  "Unable to load host folders. Please check the Docker browse root mount.";

type ProjectsRootSwitchStatus = "idle" | "pending" | "complete";

type SettingsResponse = {
  error?: string;
  settings?: {
    currentProjectsRootHostPath: string;
    pendingProjectsRootHostPath: string;
    projectsRootSwitchStatus: ProjectsRootSwitchStatus;
    projectsRootSwitchUpdatedAt: string | null;
  };
  projectsRootSwitch?: {
    composeCommand?: string;
    pendingHostPath?: string;
  };
};

type HostDirectoryEntry = {
  name: string;
  browsePath: string;
  hostPath: string;
};

type HostDirectoriesResponse = {
  error?: string;
  rootHostPath?: string;
  currentBrowsePath?: string;
  currentHostPath?: string;
  parentBrowsePath?: string | null;
  entries?: HostDirectoryEntry[];
};

function trimTrailingSeparators(value: string) {
  let normalized = value.trim();
  while (
    normalized.length > 1 &&
    !/^[A-Za-z]:[\\/]$/.test(normalized) &&
    /[\\/]$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function hostPathToBrowsePath(hostPath: string, hostBrowseRootHostPath: string) {
  const normalizedHostPath = trimTrailingSeparators(hostPath);
  const normalizedBrowseRoot = trimTrailingSeparators(hostBrowseRootHostPath);
  if (!normalizedHostPath || !normalizedBrowseRoot) {
    return "/";
  }
  if (normalizedHostPath === normalizedBrowseRoot) {
    return "/";
  }
  const prefix = `${normalizedBrowseRoot}/`;
  if (!normalizedHostPath.startsWith(prefix)) {
    return "/";
  }
  return `/${normalizedHostPath.slice(prefix.length)}`;
}

function isAbsoluteHostPath(value: string) {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

export function SystemSettingsForm({
  initialIndexWorkerConcurrency,
  initialRetrievalDocumentLimit,
  initialLlmApiKeyConfigured,
  initialLlmBaseUrl,
  initialLlmModel,
  initialLlmRetrievalModel,
  initialLlmConfigured,
  initialLlmMissingFields,
  initialCurrentProjectsRootHostPath,
  initialPendingProjectsRootHostPath,
  initialProjectsRootSwitchStatus,
  initialProjectsRootSwitchUpdatedAt,
  projectsRootEnvFilePath,
  projectsRootComposeCommand,
  projectsRootBrowseRootHostPath,
  projectsRootPickerAvailable,
}: {
  initialIndexWorkerConcurrency: number;
  initialRetrievalDocumentLimit: number;
  initialLlmApiKeyConfigured: boolean;
  initialLlmBaseUrl: string;
  initialLlmModel: string;
  initialLlmRetrievalModel: string;
  initialLlmConfigured: boolean;
  initialLlmMissingFields: string[];
  initialCurrentProjectsRootHostPath: string;
  initialPendingProjectsRootHostPath: string;
  initialProjectsRootSwitchStatus: ProjectsRootSwitchStatus;
  initialProjectsRootSwitchUpdatedAt: string | null;
  projectsRootEnvFilePath: string;
  projectsRootComposeCommand: string;
  projectsRootBrowseRootHostPath: string;
  projectsRootPickerAvailable: boolean;
}) {
  const router = useRouter();
  const [indexWorkerConcurrency, setIndexWorkerConcurrency] = useState(
    String(initialIndexWorkerConcurrency),
  );
  const [retrievalDocumentLimit, setRetrievalDocumentLimit] = useState(
    String(initialRetrievalDocumentLimit),
  );
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState(initialLlmBaseUrl);
  const [llmModel, setLlmModel] = useState(initialLlmModel);
  const [llmRetrievalModel, setLlmRetrievalModel] = useState(initialLlmRetrievalModel);
  const [currentProjectsRootHostPath, setCurrentProjectsRootHostPath] = useState(
    initialCurrentProjectsRootHostPath,
  );
  const [pendingProjectsRootHostPath, setPendingProjectsRootHostPath] = useState(
    initialPendingProjectsRootHostPath,
  );
  const [projectsRootSwitchStatus, setProjectsRootSwitchStatus] =
    useState<ProjectsRootSwitchStatus>(initialProjectsRootSwitchStatus);
  const [projectsRootSwitchUpdatedAt, setProjectsRootSwitchUpdatedAt] = useState(
    initialProjectsRootSwitchUpdatedAt,
  );
  const [projectsRootHostPath, setProjectsRootHostPath] = useState(
    initialPendingProjectsRootHostPath || initialCurrentProjectsRootHostPath,
  );
  const [projectsRootCommand, setProjectsRootCommand] = useState(projectsRootComposeCommand);
  const [showProjectsRootPicker, setShowProjectsRootPicker] = useState(false);
  const [pickerBrowsePath, setPickerBrowsePath] = useState("/");
  const [pickerHostPath, setPickerHostPath] = useState(projectsRootBrowseRootHostPath);
  const [pickerParentBrowsePath, setPickerParentBrowsePath] = useState<string | null>(null);
  const [pickerEntries, setPickerEntries] = useState<HostDirectoryEntry[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerErrorMessage, setPickerErrorMessage] = useState("");
  const [showProjectsRootDialog, setShowProjectsRootDialog] = useState(false);
  const [projectsRootSubmitting, setProjectsRootSubmitting] = useState(false);
  const [projectsRootErrorMessage, setProjectsRootErrorMessage] = useState("");
  const [projectsRootStatusMessage, setProjectsRootStatusMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const parsedConcurrency = Number.parseInt(indexWorkerConcurrency, 10);
  const parsedRetrievalDocumentLimit = Number.parseInt(retrievalDocumentLimit, 10);
  const isValidConcurrency =
    Number.isInteger(parsedConcurrency) &&
    parsedConcurrency >= 1 &&
    parsedConcurrency <= 16;
  const isValidRetrievalDocumentLimit =
    Number.isInteger(parsedRetrievalDocumentLimit) &&
    parsedRetrievalDocumentLimit >= 1 &&
    parsedRetrievalDocumentLimit <= 50;
  const isValidBaseUrl = (() => {
    const value = llmBaseUrl.trim();
    if (!value) {
      return true;
    }
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  })();
  const isValidModel = llmModel.trim().length > 0;
  const isValidRetrievalModel = llmRetrievalModel.trim().length > 0;
  const normalizedProjectsRootHostPath = trimTrailingSeparators(projectsRootHostPath);
  const isValidProjectsRootHostPath =
    normalizedProjectsRootHostPath.length > 0 &&
    !/[\r\n]/.test(normalizedProjectsRootHostPath) &&
    isAbsoluteHostPath(normalizedProjectsRootHostPath);
  const projectsRootNeedsSwitch =
    normalizedProjectsRootHostPath.length > 0 &&
    normalizedProjectsRootHostPath !== currentProjectsRootHostPath;
  const canSwitchProjectsRoot =
    isValidProjectsRootHostPath && projectsRootNeedsSwitch && !projectsRootSubmitting;
  const canSubmit =
    isValidConcurrency &&
    isValidRetrievalDocumentLimit &&
    isValidBaseUrl &&
    isValidModel &&
    isValidRetrievalModel &&
    !submitting;

  function resetMessages() {
    setStatusMessage("");
    setErrorMessage("");
  }

  function resetProjectsRootMessages() {
    setProjectsRootStatusMessage("");
    setProjectsRootErrorMessage("");
  }

  async function loadHostDirectories(browsePath: string) {
    setPickerLoading(true);
    setPickerErrorMessage("");
    try {
      const response = await fetch(
        `/api/admin/host-directories?path=${encodeURIComponent(browsePath)}`,
      );
      const payload = (await response.json().catch(() => null)) as
        | HostDirectoriesResponse
        | null;
      if (!response.ok) {
        setPickerErrorMessage(payload?.error ?? HOST_DIRECTORIES_ERROR_MESSAGE);
        return;
      }
      setPickerBrowsePath(payload?.currentBrowsePath ?? browsePath);
      setPickerHostPath(payload?.currentHostPath ?? projectsRootBrowseRootHostPath);
      setPickerParentBrowsePath(payload?.parentBrowsePath ?? null);
      setPickerEntries(payload?.entries ?? []);
    } catch {
      setPickerErrorMessage(HOST_DIRECTORIES_ERROR_MESSAGE);
    } finally {
      setPickerLoading(false);
    }
  }

  function openProjectsRootPicker() {
    if (!projectsRootPickerAvailable) {
      return;
    }
    const initialBrowsePath = hostPathToBrowsePath(
      projectsRootHostPath,
      projectsRootBrowseRootHostPath,
    );
    setShowProjectsRootPicker(true);
    void loadHostDirectories(initialBrowsePath);
  }

  function usePickerSelection() {
    setProjectsRootHostPath(pickerHostPath);
    resetProjectsRootMessages();
    setShowProjectsRootPicker(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setStatusMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          indexWorkerConcurrency: parsedConcurrency,
          retrievalDocumentLimit: parsedRetrievalDocumentLimit,
          llmApiKey: llmApiKey.trim() ? llmApiKey.trim() : undefined,
          llmBaseUrl: llmBaseUrl.trim(),
          llmModel: llmModel.trim(),
          llmRetrievalModel: llmRetrievalModel.trim(),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setErrorMessage(payload?.error ?? SAVE_ERROR_MESSAGE);
        return;
      }

      setStatusMessage("Settings saved.");
      router.refresh();
    } catch {
      setErrorMessage(SAVE_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProjectsRootSwitch() {
    if (!canSwitchProjectsRoot) {
      return;
    }

    setProjectsRootSubmitting(true);
    setProjectsRootStatusMessage("");
    setProjectsRootErrorMessage("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectsRootHostPath: normalizedProjectsRootHostPath,
        }),
      });
      const payload = (await response.json().catch(() => null)) as SettingsResponse | null;
      if (!response.ok) {
        setProjectsRootErrorMessage(payload?.error ?? PROJECTS_ROOT_ERROR_MESSAGE);
        return;
      }

      if (payload?.settings) {
        setCurrentProjectsRootHostPath(payload.settings.currentProjectsRootHostPath);
        setPendingProjectsRootHostPath(payload.settings.pendingProjectsRootHostPath);
        setProjectsRootSwitchStatus(payload.settings.projectsRootSwitchStatus);
        setProjectsRootSwitchUpdatedAt(payload.settings.projectsRootSwitchUpdatedAt);
        setProjectsRootHostPath(
          payload.settings.pendingProjectsRootHostPath ||
            payload.settings.currentProjectsRootHostPath,
        );
      } else {
        setPendingProjectsRootHostPath(normalizedProjectsRootHostPath);
        setProjectsRootSwitchStatus("pending");
      }
      if (payload?.projectsRootSwitch?.composeCommand) {
        setProjectsRootCommand(payload.projectsRootSwitch.composeCommand);
      }
      setShowProjectsRootDialog(false);
      setProjectsRootStatusMessage("Projects root switch prepared.");
      router.refresh();
    } catch {
      setProjectsRootErrorMessage(PROJECTS_ROOT_ERROR_MESSAGE);
    } finally {
      setProjectsRootSubmitting(false);
    }
  }

  const projectsRootProgress =
    projectsRootSwitchStatus === "complete"
      ? "100%"
      : projectsRootSwitchStatus === "pending"
        ? "66%"
        : "0%";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Model service
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {initialLlmConfigured
                ? "Model service is ready"
                : "Model service is not configured"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Configure the OpenAI-compatible endpoint used by document indexing and retrieval answers.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmApiKeyConfigured
                    ? "border-[var(--pi-brand-soft)] bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                    : "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                }`}
              >
                {initialLlmApiKeyConfigured ? "API key is saved" : "API key is not saved"}
              </span>
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmMissingFields.includes("Base URL")
                    ? "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                    : "border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-muted)]"
                }`}
              >
                {initialLlmMissingFields.includes("Base URL")
                  ? "Base URL is missing"
                  : "Base URL is set"}
              </span>
            </div>
          </div>
          <div className="grid w-full gap-4 lg:w-[28rem]">
            <div>
              <label htmlFor="llm-api-key" className="text-sm font-medium text-[var(--pi-ink)]">
                API key
              </label>
              <input
                id="llm-api-key"
                type="password"
                value={llmApiKey}
                placeholder={
                  initialLlmApiKeyConfigured ? "Leave blank to keep saved key" : "Paste a new API key"
                }
                autoComplete="off"
                onChange={(event) => {
                  setLlmApiKey(event.target.value);
                  resetMessages();
                }}
                className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
              />
            </div>
            <div>
              <label htmlFor="llm-base-url" className="text-sm font-medium text-[var(--pi-ink)]">
                Base URL
              </label>
              <input
                id="llm-base-url"
                type="url"
                value={llmBaseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => {
                  setLlmBaseUrl(event.target.value);
                  resetMessages();
                }}
                className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition placeholder:text-[var(--pi-muted)] focus:border-[var(--pi-brand)]"
              />
              {!isValidBaseUrl ? (
                <p className="mt-2 text-xs text-[var(--pi-danger)]">
                  Base URL must start with http:// or https://.
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="llm-model" className="text-sm font-medium text-[var(--pi-ink)]">
                  Model
                </label>
                <input
                  id="llm-model"
                  value={llmModel}
                  onChange={(event) => {
                    setLlmModel(event.target.value);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                />
              </div>
              <div>
                <label
                  htmlFor="llm-retrieval-model"
                  className="text-sm font-medium text-[var(--pi-ink)]"
                >
                  Retrieval model
                </label>
                <input
                  id="llm-retrieval-model"
                  value={llmRetrievalModel}
                  onChange={(event) => {
                    setLlmRetrievalModel(event.target.value);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Project corpus
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              Projects root
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Controls the host directory Docker mounts as the project corpus. The running containers must be recreated before the new host path is available at /data/projects.
            </p>
            <div className="mt-4 grid gap-2 text-xs text-[var(--pi-muted)]">
              <p>
                Current mounted host path:{" "}
                <span className="font-mono text-[var(--pi-ink)]">
                  {currentProjectsRootHostPath || "Not reported by Docker"}
                </span>
              </p>
              {projectsRootEnvFilePath ? (
                <p>
                  Docker env file:{" "}
                  <span className="font-mono text-[var(--pi-ink)]">
                    {projectsRootEnvFilePath}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
          <div className="w-full lg:w-[28rem]">
            <p className="text-sm font-medium text-[var(--pi-ink)]">
              Selected projects root
            </p>
            <div className="mt-2 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3">
              <p className="break-all font-mono text-sm text-[var(--pi-ink)]">
                {projectsRootHostPath || "No host folder selected"}
              </p>
              {projectsRootBrowseRootHostPath ? (
                <p className="mt-2 break-all text-xs text-[var(--pi-muted)]">
                  Folder picker root:{" "}
                  <span className="font-mono">{projectsRootBrowseRootHostPath}</span>
                </p>
              ) : null}
            </div>
            {!isValidProjectsRootHostPath ? (
              <p className="mt-2 text-xs text-[var(--pi-danger)]">
                Choose an absolute host folder for the project corpus.
              </p>
            ) : null}
            {!projectsRootPickerAvailable ? (
              <p className="mt-2 text-xs text-[var(--pi-danger)]">
                Folder picker is unavailable because REASONKB_HOST_BROWSE_ROOT is not mounted.
              </p>
            ) : null}
            <button
              type="button"
              disabled={!projectsRootPickerAvailable || projectsRootSubmitting}
              onClick={openProjectsRootPicker}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--pi-border)] bg-white px-4 py-2.5 text-sm font-medium text-[var(--pi-ink)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Folder aria-hidden="true" className="h-4 w-4" />
              Choose folder
            </button>
            <button
              type="button"
              disabled={!canSwitchProjectsRoot}
              onClick={() => setShowProjectsRootDialog(true)}
              className="ml-0 mt-3 rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 sm:ml-3 sm:mt-4"
            >
              Switch projects root
            </button>

            {projectsRootSwitchStatus !== "idle" ? (
              <div
                role="status"
                className="mt-5 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-[var(--pi-ink)]">
                    {projectsRootSwitchStatus === "complete"
                      ? "Projects root switch is complete."
                      : "Waiting for Docker recreate to mount the new project corpus."}
                  </p>
                  <span className="text-xs font-medium text-[var(--pi-muted)]">
                    {projectsRootSwitchStatus === "complete" ? "Complete" : "In progress"}
                  </span>
                </div>
                <div
                  aria-label="Projects root switch progress"
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white"
                >
                  <div
                    className="h-full rounded-full bg-[var(--pi-brand)] transition-all"
                    style={{ width: projectsRootProgress }}
                  />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-[var(--pi-muted)]">
                  <p>1. Switch target saved: {pendingProjectsRootHostPath}</p>
                  <p>
                    2.{" "}
                    {projectsRootEnvFilePath
                      ? "Docker env file updated. Recreate containers on the host."
                      : "Update REASONKB_PROJECTS_ROOT in the Docker env file, then recreate containers on the host."}
                  </p>
                  <p>
                    3. ReasonKB reports the new mounted root after restart:{" "}
                    {projectsRootSwitchStatus === "complete" ? "done" : "waiting"}
                  </p>
                  {projectsRootSwitchUpdatedAt ? (
                    <p>Requested at: {projectsRootSwitchUpdatedAt}</p>
                  ) : null}
                </div>
                <pre className="mt-3 overflow-x-auto rounded-md border border-[var(--pi-border)] bg-white p-3 text-xs text-[var(--pi-ink)]">
                  <code>{projectsRootCommand}</code>
                </pre>
              </div>
            ) : null}

            {projectsRootStatusMessage ? (
              <p className="mt-3 text-sm text-[var(--pi-brand)]">
                {projectsRootStatusMessage}
              </p>
            ) : null}
            {projectsRootErrorMessage ? (
              <p className="mt-3 text-sm text-[var(--pi-danger)]">
                {projectsRootErrorMessage}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Indexing
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              Worker concurrency
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Controls how many document index jobs the single index-worker container may run at the same time. Lower values stop new dispatches; active jobs finish naturally.
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="index-worker-concurrency"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              Concurrent jobs
            </label>
            <input
              id="index-worker-concurrency"
              type="number"
              min={1}
              max={16}
              step={1}
              value={indexWorkerConcurrency}
              onChange={(event) => {
                setIndexWorkerConcurrency(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">Allowed range: 1-16</p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Retrieval
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              Candidate document limit
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              Controls how many ready documents may be selected for a single retrieval query before evidence is loaded and the final answer is generated.
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="retrieval-document-limit"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              Retrieval documents
            </label>
            <input
              id="retrieval-document-limit"
              type="number"
              min={1}
              max={50}
              step={1}
              value={retrievalDocumentLimit}
              onChange={(event) => {
                setRetrievalDocumentLimit(event.target.value);
                resetMessages();
              }}
              className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
            />
            <p className="mt-2 text-xs text-[var(--pi-muted)]">Allowed range: 1-50</p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? "Saving..." : "Save settings"}
        </button>
        {statusMessage ? (
          <p className="text-sm text-[var(--pi-brand)]">{statusMessage}</p>
        ) : null}
        {errorMessage ? (
          <p className="text-sm text-[var(--pi-danger)]">{errorMessage}</p>
        ) : null}
      </div>

      {showProjectsRootPicker ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="projects-root-picker-title"
            className="w-full max-w-2xl rounded-lg border border-[var(--pi-border)] bg-white p-5 shadow-xl"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              Host folder picker
            </p>
            <h2
              id="projects-root-picker-title"
              className="mt-2 text-xl font-semibold text-[var(--pi-ink)]"
            >
              Choose projects root folder
            </h2>
            <div className="mt-4 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3 text-xs">
              <p className="font-medium text-[var(--pi-ink)]">Current selection</p>
              <p className="mt-1 break-all font-mono text-[var(--pi-muted)]">
                {pickerHostPath || projectsRootBrowseRootHostPath}
              </p>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={!pickerParentBrowsePath || pickerLoading}
                onClick={() => {
                  if (pickerParentBrowsePath) {
                    void loadHostDirectories(pickerParentBrowsePath);
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--pi-border)] px-3 py-2 text-sm font-medium text-[var(--pi-muted)] transition enabled:hover:border-[var(--pi-ink)] enabled:hover:text-[var(--pi-ink)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                Up
              </button>
              <p className="min-w-0 flex-1 truncate text-right font-mono text-xs text-[var(--pi-muted)]">
                {pickerBrowsePath}
              </p>
            </div>

            <div className="rk-scrollbar mt-3 max-h-72 overflow-y-auto rounded-lg border border-[var(--pi-border)]">
              {pickerLoading ? (
                <p className="p-4 text-sm text-[var(--pi-muted)]">Loading folders...</p>
              ) : pickerEntries.length > 0 ? (
                <div className="divide-y divide-[var(--pi-border)]">
                  {pickerEntries.map((entry) => (
                    <button
                      key={entry.browsePath}
                      type="button"
                      aria-label={entry.name}
                      onClick={() => void loadHostDirectories(entry.browsePath)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--pi-bg)]"
                    >
                      <FolderOpen
                        aria-hidden="true"
                        className="h-4 w-4 flex-none text-[var(--pi-brand)]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-[var(--pi-ink)]">
                          {entry.name}
                        </span>
                        <span className="block truncate font-mono text-xs text-[var(--pi-muted)]">
                          {entry.hostPath}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="p-4 text-sm text-[var(--pi-muted)]">
                  This folder has no child folders.
                </p>
              )}
            </div>

            {pickerErrorMessage ? (
              <p className="mt-3 text-sm text-[var(--pi-danger)]">
                {pickerErrorMessage}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setShowProjectsRootPicker(false)}
                className="rounded-lg border border-[var(--pi-border)] px-4 py-2.5 text-sm font-medium text-[var(--pi-muted)] transition hover:border-[var(--pi-ink)] hover:text-[var(--pi-ink)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pickerLoading || !pickerHostPath}
                onClick={usePickerSelection}
                className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Use selected folder
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showProjectsRootDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="projects-root-switch-title"
            className="w-full max-w-xl rounded-lg border border-[var(--pi-border)] bg-white p-5 shadow-xl"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-danger)]">
              Docker restart required
            </p>
            <h2
              id="projects-root-switch-title"
              className="mt-2 text-xl font-semibold text-[var(--pi-ink)]"
            >
              Switch projects root
            </h2>
            <p className="mt-3 text-sm leading-6 text-[var(--pi-muted)]">
              Docker bind mount changes require recreating the containers. ReasonKB will save the new host path now{projectsRootEnvFilePath ? " and update the Docker env file" : ""}, then wait until Docker restarts with that path mounted.
            </p>
            <div className="mt-4 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3 text-xs">
              <p className="font-medium text-[var(--pi-ink)]">Target host path</p>
              <p className="mt-1 break-all font-mono text-[var(--pi-muted)]">
                {normalizedProjectsRootHostPath}
              </p>
            </div>
            <div className="mt-4 grid gap-2 text-sm text-[var(--pi-muted)]">
              <p>Progress will show the saved target, the Docker recreate step, and completion after the restarted app reports the new mounted root.</p>
              <p>Run this on the host after confirming:</p>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-md border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3 text-xs text-[var(--pi-ink)]">
              <code>{projectsRootCommand}</code>
            </pre>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setShowProjectsRootDialog(false)}
                className="rounded-lg border border-[var(--pi-border)] px-4 py-2.5 text-sm font-medium text-[var(--pi-muted)] transition hover:border-[var(--pi-ink)] hover:text-[var(--pi-ink)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={projectsRootSubmitting}
                onClick={handleProjectsRootSwitch}
                className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {projectsRootSubmitting ? "Preparing..." : "Confirm switch"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
