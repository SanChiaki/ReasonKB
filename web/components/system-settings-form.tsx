"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Folder, FolderOpen, FlaskConical } from "lucide-react";
import { LanguageSwitcher, useI18n } from "@/lib/i18n";
import {
  splitLlmModel,
  type LlmInterfaceFormat,
} from "@/lib/llm-model-format";

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

type LlmTestResponse = {
  success: boolean;
  model: string;
  elapsedMs: number;
  output: string;
  errorType?: string | null;
  message: string;
  details?: string;
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
  const { t } = useI18n();
  const [indexWorkerConcurrency, setIndexWorkerConcurrency] = useState(
    String(initialIndexWorkerConcurrency),
  );
  const [retrievalDocumentLimit, setRetrievalDocumentLimit] = useState(
    String(initialRetrievalDocumentLimit),
  );
  const [llmApiKey, setLlmApiKey] = useState("");
  const initialAnswerModel = splitLlmModel(initialLlmModel);
  const initialRetrievalModel = splitLlmModel(initialLlmRetrievalModel);
  const [llmBaseUrl, setLlmBaseUrl] = useState(initialLlmBaseUrl);
  const [llmInterfaceFormat, setLlmInterfaceFormat] =
    useState<LlmInterfaceFormat>(initialAnswerModel.interfaceFormat);
  const [llmModelName, setLlmModelName] = useState(initialAnswerModel.modelName);
  const [llmRetrievalInterfaceFormat, setLlmRetrievalInterfaceFormat] =
    useState<LlmInterfaceFormat>(initialRetrievalModel.interfaceFormat);
  const [llmRetrievalModelName, setLlmRetrievalModelName] = useState(
    initialRetrievalModel.modelName,
  );
  const [useSeparateRetrievalModel, setUseSeparateRetrievalModel] = useState(
    initialAnswerModel.interfaceFormat !== initialRetrievalModel.interfaceFormat ||
      initialAnswerModel.modelName !== initialRetrievalModel.modelName,
  );
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
  const [llmTestSubmitting, setLlmTestSubmitting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<LlmTestResponse | null>(null);
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
  const isValidModel = llmModelName.trim().length > 0;
  const effectiveRetrievalInterfaceFormat = useSeparateRetrievalModel
    ? llmRetrievalInterfaceFormat
    : llmInterfaceFormat;
  const effectiveRetrievalModelName = useSeparateRetrievalModel
    ? llmRetrievalModelName
    : llmModelName;
  const isValidRetrievalModel =
    !useSeparateRetrievalModel || llmRetrievalModelName.trim().length > 0;
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
    setLlmTestResult(null);
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
        setPickerErrorMessage(payload?.error ?? t("settings.hostDirectoriesError"));
        return;
      }
      setPickerBrowsePath(payload?.currentBrowsePath ?? browsePath);
      setPickerHostPath(payload?.currentHostPath ?? projectsRootBrowseRootHostPath);
      setPickerParentBrowsePath(payload?.parentBrowsePath ?? null);
      setPickerEntries(payload?.entries ?? []);
    } catch {
      setPickerErrorMessage(t("settings.hostDirectoriesError"));
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
          llmInterfaceFormat,
          llmModelName: llmModelName.trim(),
          llmRetrievalInterfaceFormat: effectiveRetrievalInterfaceFormat,
          llmRetrievalModelName: effectiveRetrievalModelName.trim(),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setErrorMessage(payload?.error ?? t("settings.saveError"));
        return;
      }

      setStatusMessage(t("settings.saved"));
      router.refresh();
    } catch {
      setErrorMessage(t("settings.saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLlmTest() {
    if (!isValidBaseUrl || !isValidModel || llmTestSubmitting) {
      return;
    }

    setLlmTestSubmitting(true);
    setLlmTestResult(null);
    setStatusMessage("");
    setErrorMessage("");
    try {
      const payload = {
        ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {}),
        baseUrl: llmBaseUrl.trim(),
        interfaceFormat: llmInterfaceFormat,
        modelName: llmModelName.trim(),
      };
      const response = await fetch("/api/admin/settings/llm-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as
        | LlmTestResponse
        | { error?: string }
        | null;
      if (!response.ok || !result || !("success" in result)) {
        setLlmTestResult({
          success: false,
          model: llmModelName.trim(),
          elapsedMs: 0,
          output: "",
          errorType: "configuration",
          message:
            result && "error" in result && result.error
              ? result.error
              : t("settings.modelTestError"),
          details: "",
        });
        return;
      }
      setLlmTestResult(result);
    } catch (error) {
      setLlmTestResult({
        success: false,
        model: llmModelName.trim(),
        elapsedMs: 0,
        output: "",
        errorType: "connection",
        message: t("settings.modelTestError"),
        details: error instanceof Error ? error.message : "",
      });
    } finally {
      setLlmTestSubmitting(false);
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
        setProjectsRootErrorMessage(payload?.error ?? t("settings.rootPrepareError"));
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
      setProjectsRootStatusMessage(t("settings.rootPrepared"));
      router.refresh();
    } catch {
      setProjectsRootErrorMessage(t("settings.rootPrepareError"));
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
              {t("language.settingsEyebrow")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {t("language.settingsTitle")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("language.settingsDescription")}
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <LanguageSwitcher />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              {t("settings.modelEyebrow")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {initialLlmConfigured
                ? t("settings.modelReady")
                : t("settings.modelMissing")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("settings.modelDescription")}
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmApiKeyConfigured
                    ? "border-[var(--pi-brand-soft)] bg-[var(--pi-brand-soft)] text-[var(--pi-brand)]"
                    : "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                }`}
              >
                {initialLlmApiKeyConfigured
                  ? t("settings.apiKeySaved")
                  : t("settings.apiKeyMissing")}
              </span>
              <span
                className={`rounded-md border px-2.5 py-1 ${
                  initialLlmMissingFields.includes("Base URL")
                    ? "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.08)] text-[var(--pi-danger)]"
                    : "border-[var(--pi-border)] bg-[var(--pi-bg)] text-[var(--pi-muted)]"
                }`}
              >
                {initialLlmMissingFields.includes("Base URL")
                  ? t("settings.baseUrlMissing")
                  : t("settings.baseUrlSet")}
              </span>
            </div>
          </div>
          <div className="grid w-full gap-4 lg:w-[28rem]">
            <div>
              <label htmlFor="llm-api-key" className="text-sm font-medium text-[var(--pi-ink)]">
                {t("settings.apiKey")}
              </label>
              <input
                id="llm-api-key"
                type="password"
                value={llmApiKey}
                placeholder={
                  initialLlmApiKeyConfigured
                    ? t("settings.keepApiKey")
                    : t("settings.pasteApiKey")
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
                {t("settings.baseUrl")}
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
                  {t("settings.invalidBaseUrl")}
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="llm-interface-format"
                  className="text-sm font-medium text-[var(--pi-ink)]"
                >
                  {t("settings.interfaceFormat")}
                </label>
                <select
                  id="llm-interface-format"
                  value={llmInterfaceFormat}
                  onChange={(event) => {
                    setLlmInterfaceFormat(event.target.value as LlmInterfaceFormat);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                >
                  <option value="openai-compatible">
                    {t("settings.interfaceOpenAiCompatible")}
                  </option>
                  <option value="anthropic-messages">
                    {t("settings.interfaceAnthropicMessages")}
                  </option>
                </select>
              </div>
              <div>
                <label htmlFor="llm-model" className="text-sm font-medium text-[var(--pi-ink)]">
                  {t("settings.model")}
                </label>
                <input
                  id="llm-model"
                  value={llmModelName}
                  onChange={(event) => {
                    setLlmModelName(event.target.value);
                    resetMessages();
                  }}
                  className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                />
              </div>
            </div>
            <label
              htmlFor="llm-use-separate-retrieval-model"
              className="flex items-start gap-3 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3"
            >
              <input
                id="llm-use-separate-retrieval-model"
                type="checkbox"
                checked={useSeparateRetrievalModel}
                onChange={(event) => {
                  const nextUseSeparateRetrievalModel = event.target.checked;
                  if (
                    nextUseSeparateRetrievalModel &&
                    !useSeparateRetrievalModel
                  ) {
                    setLlmRetrievalInterfaceFormat(llmInterfaceFormat);
                    setLlmRetrievalModelName(llmModelName);
                  }
                  setUseSeparateRetrievalModel(nextUseSeparateRetrievalModel);
                  resetMessages();
                }}
                className="mt-1 h-4 w-4 rounded border-[var(--pi-border)] text-[var(--pi-brand)] focus:ring-[var(--pi-brand)]"
              />
              <span>
                <span className="block text-sm font-medium text-[var(--pi-ink)]">
                  {t("settings.useSeparateRetrievalModel")}
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--pi-muted)]">
                  {t("settings.useSeparateRetrievalModelDescription")}
                </span>
              </span>
            </label>
            {useSeparateRetrievalModel ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="llm-retrieval-interface-format"
                    className="text-sm font-medium text-[var(--pi-ink)]"
                  >
                    {t("settings.retrievalInterfaceFormat")}
                  </label>
                  <select
                    id="llm-retrieval-interface-format"
                    value={llmRetrievalInterfaceFormat}
                    onChange={(event) => {
                      setLlmRetrievalInterfaceFormat(
                        event.target.value as LlmInterfaceFormat,
                      );
                      resetMessages();
                    }}
                    className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                  >
                    <option value="openai-compatible">
                      {t("settings.interfaceOpenAiCompatible")}
                    </option>
                    <option value="anthropic-messages">
                      {t("settings.interfaceAnthropicMessages")}
                    </option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="llm-retrieval-model"
                    className="text-sm font-medium text-[var(--pi-ink)]"
                  >
                    {t("settings.retrievalModel")}
                  </label>
                  <input
                    id="llm-retrieval-model"
                    value={llmRetrievalModelName}
                    onChange={(event) => {
                      setLlmRetrievalModelName(event.target.value);
                      resetMessages();
                    }}
                    className="mt-2 w-full rounded-lg border border-[var(--pi-border)] bg-white px-4 py-3 text-sm text-[var(--pi-ink)] outline-none transition focus:border-[var(--pi-brand)]"
                  />
                </div>
              </div>
            ) : null}
            <div className="rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--pi-ink)]">
                    {t("settings.modelTest")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--pi-muted)]">
                    {t("settings.modelTestDescription")}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!isValidBaseUrl || !isValidModel || llmTestSubmitting}
                  onClick={handleLlmTest}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--pi-border)] bg-white px-4 py-2.5 text-sm font-medium text-[var(--pi-ink)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FlaskConical aria-hidden="true" className="h-4 w-4" />
                  {llmTestSubmitting
                    ? t("settings.modelTesting")
                    : t("settings.testModel")}
                </button>
              </div>
              {llmTestResult ? (
                <div
                  role="status"
                  className={`mt-3 rounded-md border p-3 text-sm ${
                    llmTestResult.success
                      ? "border-[var(--pi-brand-soft)] bg-white text-[var(--pi-ink)]"
                      : "border-[var(--pi-danger)] bg-[rgba(190,18,60,0.06)] text-[var(--pi-ink)]"
                  }`}
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <p
                      className={
                        llmTestResult.success
                          ? "font-medium text-[var(--pi-brand)]"
                          : "font-medium text-[var(--pi-danger)]"
                      }
                    >
                      {llmTestResult.message}
                    </p>
                    <span className="text-xs text-[var(--pi-muted)]">
                      {llmTestResult.elapsedMs} ms
                    </span>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-[var(--pi-muted)]">
                    {llmTestResult.model}
                  </p>
                  {llmTestResult.output ? (
                    <p className="mt-2 rounded border border-[var(--pi-border)] bg-white px-3 py-2 font-mono text-xs text-[var(--pi-ink)]">
                      {llmTestResult.output}
                    </p>
                  ) : null}
                  {!llmTestResult.success && llmTestResult.details ? (
                    <p className="mt-2 break-words text-xs text-[var(--pi-muted)]">
                      {llmTestResult.details}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              {t("settings.projectCorpus")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {t("settings.projectsRoot")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("settings.projectsRootDescription")}
            </p>
            <div className="mt-4 grid gap-2 text-xs text-[var(--pi-muted)]">
              <p>
                {t("settings.currentMountedHostPath")}{" "}
                <span className="font-mono text-[var(--pi-ink)]">
                  {currentProjectsRootHostPath || t("settings.notReportedByDocker")}
                </span>
              </p>
              {projectsRootEnvFilePath ? (
                <p>
                  {t("settings.dockerEnvFile")}{" "}
                  <span className="font-mono text-[var(--pi-ink)]">
                    {projectsRootEnvFilePath}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
          <div className="w-full lg:w-[28rem]">
            <p className="text-sm font-medium text-[var(--pi-ink)]">
              {t("settings.selectedProjectsRoot")}
            </p>
            <div className="mt-2 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3">
              <p className="break-all font-mono text-sm text-[var(--pi-ink)]">
                {projectsRootHostPath || t("settings.noHostFolderSelected")}
              </p>
              {projectsRootBrowseRootHostPath ? (
                <p className="mt-2 break-all text-xs text-[var(--pi-muted)]">
                  {t("settings.folderPickerRoot")}{" "}
                  <span className="font-mono">{projectsRootBrowseRootHostPath}</span>
                </p>
              ) : null}
            </div>
            {!isValidProjectsRootHostPath ? (
              <p className="mt-2 text-xs text-[var(--pi-danger)]">
                {t("settings.chooseAbsoluteHostFolder")}
              </p>
            ) : null}
            {!projectsRootPickerAvailable ? (
              <p className="mt-2 text-xs text-[var(--pi-danger)]">
                {t("settings.pickerUnavailable")}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!projectsRootPickerAvailable || projectsRootSubmitting}
              onClick={openProjectsRootPicker}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--pi-border)] bg-white px-4 py-2.5 text-sm font-medium text-[var(--pi-ink)] transition enabled:hover:border-[var(--pi-brand)] enabled:hover:text-[var(--pi-brand)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Folder aria-hidden="true" className="h-4 w-4" />
              {t("settings.chooseFolder")}
            </button>
            <button
              type="button"
              disabled={!canSwitchProjectsRoot}
              onClick={() => setShowProjectsRootDialog(true)}
              className="ml-0 mt-3 rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 sm:ml-3 sm:mt-4"
            >
              {t("settings.switchProjectsRoot")}
            </button>

            {projectsRootSwitchStatus !== "idle" ? (
              <div
                role="status"
                className="mt-5 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-[var(--pi-ink)]">
                    {projectsRootSwitchStatus === "complete"
                      ? t("settings.switchComplete")
                      : t("settings.switchWaiting")}
                  </p>
                  <span className="text-xs font-medium text-[var(--pi-muted)]">
                    {projectsRootSwitchStatus === "complete"
                      ? t("common.complete")
                      : t("common.inProgress")}
                  </span>
                </div>
                <div
                  aria-label={t("settings.switchProgressAria")}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white"
                >
                  <div
                    className="h-full rounded-full bg-[var(--pi-brand)] transition-all"
                    style={{ width: projectsRootProgress }}
                  />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-[var(--pi-muted)]">
                  <p>
                    {t("settings.switchStep1", { path: pendingProjectsRootHostPath })}
                  </p>
                  <p>
                    2.{" "}
                    {projectsRootEnvFilePath
                      ? t("settings.switchStep2Env")
                      : t("settings.switchStep2Manual")}
                  </p>
                  <p>
                    {t("settings.switchStep3", {
                      status:
                        projectsRootSwitchStatus === "complete"
                          ? t("settings.done")
                          : t("settings.waiting"),
                    })}
                  </p>
                  {projectsRootSwitchUpdatedAt ? (
                    <p>
                      {t("settings.requestedAt", { date: projectsRootSwitchUpdatedAt })}
                    </p>
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
              {t("settings.indexing")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {t("settings.workerConcurrency")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("settings.workerDescription")}
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="index-worker-concurrency"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.concurrentJobs")}
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
            <p className="mt-2 text-xs text-[var(--pi-muted)]">
              {t("settings.allowedRange", { range: "1-16" })}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--pi-border)] bg-white p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--pi-brand)]">
              {t("settings.retrieval")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--pi-ink)]">
              {t("settings.candidateLimit")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--pi-muted)]">
              {t("settings.retrievalDescription")}
            </p>
          </div>
          <div className="w-full lg:w-[18rem]">
            <label
              htmlFor="retrieval-document-limit"
              className="text-sm font-medium text-[var(--pi-ink)]"
            >
              {t("settings.retrievalDocuments")}
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
            <p className="mt-2 text-xs text-[var(--pi-muted)]">
              {t("settings.allowedRange", { range: "1-50" })}
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? t("common.saving") : t("settings.saveSettings")}
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
              {t("settings.hostFolderPicker")}
            </p>
            <h2
              id="projects-root-picker-title"
              className="mt-2 text-xl font-semibold text-[var(--pi-ink)]"
            >
              {t("settings.chooseRootFolder")}
            </h2>
            <div className="mt-4 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3 text-xs">
              <p className="font-medium text-[var(--pi-ink)]">
                {t("settings.currentSelection")}
              </p>
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
                {t("common.up")}
              </button>
              <p className="min-w-0 flex-1 truncate text-right font-mono text-xs text-[var(--pi-muted)]">
                {pickerBrowsePath}
              </p>
            </div>

            <div className="rk-scrollbar mt-3 max-h-72 overflow-y-auto rounded-lg border border-[var(--pi-border)]">
              {pickerLoading ? (
                <p className="p-4 text-sm text-[var(--pi-muted)]">
                  {t("common.loadingFolders")}
                </p>
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
                  {t("settings.emptyFolder")}
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
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={pickerLoading || !pickerHostPath}
                onClick={usePickerSelection}
                className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {t("settings.useSelectedFolder")}
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
              {t("settings.dockerRestartRequired")}
            </p>
            <h2
              id="projects-root-switch-title"
              className="mt-2 text-xl font-semibold text-[var(--pi-ink)]"
            >
              {t("settings.switchProjectsRoot")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[var(--pi-muted)]">
              {t("settings.switchDialogDescription", {
                envNote: projectsRootEnvFilePath ? t("settings.envNote") : "",
              })}
            </p>
            <div className="mt-4 rounded-lg border border-[var(--pi-border)] bg-[var(--pi-bg)] p-3 text-xs">
              <p className="font-medium text-[var(--pi-ink)]">
                {t("settings.targetHostPath")}
              </p>
              <p className="mt-1 break-all font-mono text-[var(--pi-muted)]">
                {normalizedProjectsRootHostPath}
              </p>
            </div>
            <div className="mt-4 grid gap-2 text-sm text-[var(--pi-muted)]">
              <p>{t("settings.progressWillShow")}</p>
              <p>{t("settings.runOnHost")}</p>
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
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={projectsRootSubmitting}
                onClick={handleProjectsRootSwitch}
                className="rounded-lg border border-[var(--pi-brand)] bg-[var(--pi-brand)] px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {projectsRootSubmitting
                  ? t("settings.preparing")
                  : t("settings.confirmSwitch")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
