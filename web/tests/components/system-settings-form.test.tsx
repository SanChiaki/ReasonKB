/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemSettingsForm } from "@/components/system-settings-form";
import { I18nProvider } from "@/lib/i18n";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

function renderWithI18n(children: React.ReactNode) {
  return render(<I18nProvider>{children}</I18nProvider>);
}

beforeEach(() => {
  if (localStorageDescriptor) {
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
  }
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  routerMocks.refresh.mockClear();
  if (localStorageDescriptor) {
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
  }
});

describe("SystemSettingsForm", () => {
  it("moves language switching into settings and persists the selected locale", async () => {
    renderWithI18n(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByRole("heading", { name: "界面语言" })).toBeInTheDocument();
    expect(screen.getByText("选择 Web UI 显示语言。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Interface language" })).toBeInTheDocument();
    });
    expect(screen.getByText("Choose the Web UI display language.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.localStorage.getItem("reasonkb.locale")).toBe("en");
  });

  it("switches settings language when locale storage is unavailable", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is blocked");
      },
    });

    renderWithI18n(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByRole("heading", { name: "界面语言" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Interface language" })).toBeInTheDocument();
    });
  });

  it("saves runtime settings", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: {
              indexWorkerConcurrency: 4,
              retrievalDocumentLimit: 12,
              llmApiKeyConfigured: true,
              llmBaseUrl: "https://llm.example.test/v1",
              llmModel: "openai/deepseek-v4-flash",
              llmRetrievalModel: "openai/deepseek-v4-flash",
              llmConfigured: true,
              llmMissingFields: [],
              currentProjectsRootHostPath: "/Volumes/Old/Projects",
              pendingProjectsRootHostPath: "",
              projectsRootSwitchStatus: "idle",
              projectsRootSwitchUpdatedAt: null,
            },
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Volumes/Old/Projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/concurrent jobs/i), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText(/retrieval documents/i), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-test" },
    });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://llm.example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^interface format$/i), {
      target: { value: "anthropic-messages" },
    });
    fireEvent.change(screen.getByLabelText(/^model$/i), {
      target: { value: "claude-3-5-sonnet-latest" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          indexWorkerConcurrency: 4,
          retrievalDocumentLimit: 12,
          llmApiKey: "sk-test",
          llmBaseUrl: "https://llm.example.test/v1",
          llmInterfaceFormat: "anthropic-messages",
          llmModelName: "claude-3-5-sonnet-latest",
          llmRetrievalInterfaceFormat: "anthropic-messages",
          llmRetrievalModelName: "claude-3-5-sonnet-latest",
        }),
      }),
    );
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/settings saved/i)).toBeInTheDocument();
  });

  it("shows missing model configuration with a visible API key status", () => {
    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByText(/model service is not configured/i)).toBeInTheDocument();
    expect(screen.getByText(/api key is not saved/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api key/i)).toHaveAttribute(
      "placeholder",
      "Paste a new API key",
    );
  });

  it("uses one model by default when answer and retrieval models match", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: {
              indexWorkerConcurrency: 2,
              retrievalDocumentLimit: 5,
              llmApiKeyConfigured: true,
              llmBaseUrl: "https://api.deepseek.com",
              llmModel: "openai/deepseek-v4-flash",
              llmRetrievalModel: "openai/deepseek-v4-flash",
              llmConfigured: true,
              llmMissingFields: [],
              currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
              pendingProjectsRootHostPath: "",
              projectsRootSwitchStatus: "idle",
              projectsRootSwitchUpdatedAt: null,
            },
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={true}
        initialLlmBaseUrl="https://api.deepseek.com"
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={true}
        initialLlmMissingFields={[]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByLabelText(/^interface format$/i)).toHaveValue(
      "openai-compatible",
    );
    expect(screen.getByLabelText(/^model$/i)).toHaveValue("deepseek-v4-flash");
    expect(
      screen.getByRole("checkbox", { name: /use a separate retrieval model/i }),
    ).not.toBeChecked();
    expect(
      screen.queryByLabelText(/retrieval interface format/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^retrieval model$/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^interface format$/i), {
      target: { value: "anthropic-messages" },
    });
    fireEvent.change(screen.getByLabelText(/^model$/i), {
      target: { value: "claude-3-5-sonnet-latest" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          indexWorkerConcurrency: 2,
          retrievalDocumentLimit: 5,
          llmBaseUrl: "https://api.deepseek.com",
          llmInterfaceFormat: "anthropic-messages",
          llmModelName: "claude-3-5-sonnet-latest",
          llmRetrievalInterfaceFormat: "anthropic-messages",
          llmRetrievalModelName: "claude-3-5-sonnet-latest",
        }),
      }),
    );
  });

  it("shows separate retrieval model fields only when enabled", () => {
    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={true}
        initialLlmBaseUrl="https://api.deepseek.com"
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="anthropic/claude-3-5-sonnet-latest"
        initialLlmConfigured={true}
        initialLlmMissingFields={[]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByLabelText(/^interface format$/i)).toHaveValue(
      "openai-compatible",
    );
    expect(screen.getByLabelText(/^model$/i)).toHaveValue("deepseek-v4-flash");
    expect(
      screen.getByRole("checkbox", { name: /use a separate retrieval model/i }),
    ).toBeChecked();
    expect(screen.getByLabelText(/retrieval interface format/i)).toHaveValue(
      "anthropic-messages",
    );
    expect(screen.getByLabelText(/^retrieval model$/i)).toHaveValue(
      "claude-3-5-sonnet-latest",
    );
  });

  it("saves an explicitly enabled separate retrieval model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: {
              indexWorkerConcurrency: 2,
              retrievalDocumentLimit: 5,
              llmApiKeyConfigured: true,
              llmBaseUrl: "https://api.deepseek.com",
              llmModel: "openai/deepseek-v4-flash",
              llmRetrievalModel: "anthropic/claude-3-5-haiku-latest",
              llmConfigured: true,
              llmMissingFields: [],
              currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
              pendingProjectsRootHostPath: "",
              projectsRootSwitchStatus: "idle",
              projectsRootSwitchUpdatedAt: null,
            },
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={true}
        initialLlmBaseUrl="https://api.deepseek.com"
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={true}
        initialLlmMissingFields={[]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /use a separate retrieval model/i }),
    );
    expect(screen.getByLabelText(/retrieval interface format/i)).toHaveValue(
      "openai-compatible",
    );
    expect(screen.getByLabelText(/^retrieval model$/i)).toHaveValue(
      "deepseek-v4-flash",
    );

    fireEvent.change(screen.getByLabelText(/retrieval interface format/i), {
      target: { value: "anthropic-messages" },
    });
    fireEvent.change(screen.getByLabelText(/^retrieval model$/i), {
      target: { value: "claude-3-5-haiku-latest" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          indexWorkerConcurrency: 2,
          retrievalDocumentLimit: 5,
          llmBaseUrl: "https://api.deepseek.com",
          llmInterfaceFormat: "openai-compatible",
          llmModelName: "deepseek-v4-flash",
          llmRetrievalInterfaceFormat: "anthropic-messages",
          llmRetrievalModelName: "claude-3-5-haiku-latest",
        }),
      }),
    );
  });

  it("tests the current LLM settings while preserving a blank saved API key field", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            model: "openai/deepseek-v4-flash",
            elapsedMs: 42,
            output: "OK",
            errorType: null,
            message: "Model test succeeded.",
            details: "",
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={true}
        initialLlmBaseUrl="https://llm.example.test/v1"
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={true}
        initialLlmMissingFields={[]}
        initialCurrentProjectsRootHostPath="/Users/oam/.reasonkb/projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/llm-test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          baseUrl: "https://llm.example.test/v1",
          interfaceFormat: "openai-compatible",
          modelName: "deepseek-v4-flash",
        }),
      }),
    );
    expect(screen.getByText(/model test succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/42 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/ok/i)).toBeInTheDocument();
  });

  it("uses a folder picker before switching the Docker projects root and shows progress", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rootHostPath: "/Users/oam",
            currentBrowsePath: "/",
            currentHostPath: "/Users/oam",
            parentBrowsePath: null,
            entries: [
              {
                name: "Workspace",
                browsePath: "/Workspace",
                hostPath: "/Users/oam/Workspace",
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rootHostPath: "/Users/oam",
            currentBrowsePath: "/Workspace",
            currentHostPath: "/Users/oam/Workspace",
            parentBrowsePath: "/",
            entries: [
              {
                name: "Corpus",
                browsePath: "/Workspace/Corpus",
                hostPath: "/Users/oam/Workspace/Corpus",
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rootHostPath: "/Users/oam",
            currentBrowsePath: "/Workspace/Corpus",
            currentHostPath: "/Users/oam/Workspace/Corpus",
            parentBrowsePath: "/Workspace",
            entries: [],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settings: {
              indexWorkerConcurrency: 2,
              retrievalDocumentLimit: 5,
              llmApiKeyConfigured: false,
              llmBaseUrl: "",
              llmModel: "openai/deepseek-v4-flash",
              llmRetrievalModel: "openai/deepseek-v4-flash",
              llmConfigured: false,
              llmMissingFields: ["API key", "Base URL"],
              currentProjectsRootHostPath: "/Volumes/Old/Projects",
              pendingProjectsRootHostPath: "/Users/oam/Workspace/Corpus",
              projectsRootSwitchStatus: "pending",
              projectsRootSwitchUpdatedAt: "2026-05-31T00:00:00.000Z",
            },
            projectsRootSwitch: {
              envFilePath: "/Users/oam/.reasonkb/.env",
              composeCommand:
                "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
              pendingHostPath: "/Users/oam/Workspace/Corpus",
            },
          }),
        ),
      );

    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Volumes/Old/Projects"
        initialPendingProjectsRootHostPath=""
        initialProjectsRootSwitchStatus="idle"
        initialProjectsRootSwitchUpdatedAt={null}
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(
      screen.queryByRole("textbox", { name: /projects root host path/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    expect(
      await screen.findByRole("dialog", { name: /choose projects root folder/i }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Corpus" }));
    expect(
      await screen.findByText("/Users/oam/Workspace/Corpus"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use selected folder/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /choose projects root folder/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("/Users/oam/Workspace/Corpus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /switch projects root/i }));

    expect(
      screen.getByRole("dialog", { name: /switch projects root/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/docker bind mount changes require recreating the containers/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm switch/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/host-directories?path=%2F",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/host-directories?path=%2FWorkspace",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/host-directories?path=%2FWorkspace%2FCorpus",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          projectsRootHostPath: "/Users/oam/Workspace/Corpus",
        }),
      }),
    );
    expect(
      screen.getByText(/waiting for docker recreate to mount the new project corpus/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
      ),
    ).toBeInTheDocument();
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows completion when Docker reports the requested projects root", () => {
    render(
      <SystemSettingsForm
        initialIndexWorkerConcurrency={2}
        initialRetrievalDocumentLimit={5}
        initialLlmApiKeyConfigured={false}
        initialLlmBaseUrl=""
        initialLlmModel="openai/deepseek-v4-flash"
        initialLlmRetrievalModel="openai/deepseek-v4-flash"
        initialLlmConfigured={false}
        initialLlmMissingFields={["API key", "Base URL"]}
        initialCurrentProjectsRootHostPath="/Volumes/Corpus/ReasonKB"
        initialPendingProjectsRootHostPath="/Volumes/Corpus/ReasonKB"
        initialProjectsRootSwitchStatus="complete"
        initialProjectsRootSwitchUpdatedAt="2026-05-31T00:00:00.000Z"
        projectsRootEnvFilePath="/Users/oam/.reasonkb/.env"
        projectsRootComposeCommand="docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans"
        projectsRootBrowseRootHostPath="/Users/oam"
        projectsRootPickerAvailable={true}
      />,
    );

    expect(screen.getByText(/projects root switch is complete/i)).toBeInTheDocument();
    expect(screen.getAllByText("/Volumes/Corpus/ReasonKB").length).toBeGreaterThan(0);
  });
});
