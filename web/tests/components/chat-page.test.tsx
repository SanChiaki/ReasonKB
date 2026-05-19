/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageList } from "@/components/chat-message-list";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

afterEach(() => {
  routerMocks.push.mockClear();
  routerMocks.refresh.mockClear();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/repos/conversation-store");
  vi.unmock("@/lib/repos/project-store");
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chat page components", () => {
  it("sends a global retrieval query when no project is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ answer: "stub", citations: [], selectedDocuments: [], evidence: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[
          { id: "proj_1", name: "Alpha" },
          { id: "proj_2", name: "Beta" },
        ]}
        selectedProjectIds={[]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "How did revenue change?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectIds: [] }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          conversationId: "conv_new",
          projectIds: [],
          message: "How did revenue change?",
          mode: "answer",
        }),
      }),
    );
  });

  it("creates a conversation before sending and then navigates to it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ answer: "stub", citations: [], selectedDocuments: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[
          { id: "proj_1", name: "Alpha" },
          { id: "proj_2", name: "Beta" },
        ]}
        selectedProjectIds={["proj_1"]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Summarize Alpha documents" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectIds: ["proj_1"] }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          conversationId: "conv_new",
          projectIds: ["proj_1"],
          message: "Summarize Alpha documents",
          mode: "answer",
        }),
      }),
    );
    expect(routerMocks.push).toHaveBeenCalledWith("/chat?conversationId=conv_new");
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("sends evidence mode when the retrieval mode toggle is switched", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ answer: "", citations: [], selectedDocuments: [], evidence: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={["proj_1"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /evidence mode/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Show me supporting evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          conversationId: "conv_new",
          projectIds: ["proj_1"],
          message: "Show me supporting evidence",
          mode: "evidence",
        }),
      }),
    );
  });

  it("shows an error message when sending fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Retrieval failed" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={["proj_1"]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Summarize Alpha documents" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(
      screen.getByText(/unable to send message\. please try again\./i),
    ).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it("ignores repeated submits while a send is already in flight", async () => {
    let resolveCreate: ((value: { ok: boolean; json: () => Promise<{ id: string }> }) => void) |
      undefined;
    const createPromise = new Promise<{ ok: boolean; json: () => Promise<{ id: string }> }>(
      (resolve) => {
        resolveCreate = resolve;
      },
    );
    const fetchMock = vi.fn(() => createPromise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={["proj_1"]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Summarize Alpha documents" },
    });

    const form = screen.getByRole("textbox").closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate?.({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      });
      await createPromise;
    });
  });

  it("renders citation details for assistant messages", () => {
    render(
      <ChatMessageList
        messages={[
          {
            id: "msg_1",
            role: "user",
            content: "What pages mention revenue?",
            citations: [],
          },
          {
            id: "msg_2",
            role: "assistant",
            content: "The revenue summary appears in two places.",
            citations: [
              {
              projectId: "proj_1",
              projectName: "Alpha",
              documentId: "doc_1",
              documentName: "Q1 Summary.pdf",
              pages: "2-3",
              focusPage: 3,
              excerpt: "Revenue increased after the migration completed.",
            },
          ],
        },
      ]}
      />,
    );

    expect(screen.getByText("The revenue summary appears in two places.")).toBeVisible();
    expect(
      screen.getByText(/\[Alpha\] Q1 Summary\.pdf - pages 2-3 · focus page 3/i),
    ).toBeVisible();
    expect(
      screen.getByText("Revenue increased after the migration completed."),
    ).toBeVisible();
  });

  it("renders evidence cards for assistant messages", () => {
    render(
      <ChatMessageList
        messages={[
          {
            id: "msg_1",
            role: "assistant",
            content: "Evidence mode returned 1 item.",
            citations: [],
            evidence: [
              {
                projectName: "Alpha",
                documentName: "handover.md",
                sourceRelativePath: "Alpha/delivery/handover.md",
                projectRelativePath: "delivery/handover.md",
                pages: "1",
                evidenceKind: "markdown_text",
                excerpt: "Acceptance evidence",
                content: "Acceptance evidence and handover notes.",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Evidence mode returned 1 item.")).toBeVisible();
    expect(screen.getByText("delivery/handover.md")).toBeVisible();
    expect(screen.getByText("Acceptance evidence and handover notes.")).toBeVisible();
    expect(screen.queryByText(/\[Alpha\] handover\.md - pages 1/i)).not.toBeInTheDocument();
  });

  it("falls back to an empty chat state when conversation is outside owner scope", async () => {
    const listConversations = vi.fn(() => [
      { id: "conv_1", title: "Quarterly review", scopeLabel: "Alpha" },
    ]);
    const getConversationDetail = vi.fn(() => null);
    const listProjects = vi.fn(() => [{ id: "proj_1", name: "Alpha" }]);

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/chat-page-test.db",
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));
    vi.doMock("@/lib/repos/conversation-store", () => ({
      listConversations,
      getConversationDetail,
    }));
    vi.doMock("@/lib/repos/project-store", () => ({
      listProjects,
    }));
    vi.doMock("@/lib/repos/system-settings-store", () => ({
      getSystemSettings: () => ({
        indexWorkerConcurrency: 1,
        retrievalDocumentLimit: 5,
        llmApiKeyConfigured: false,
        llmBaseUrl: "",
        llmModel: "openai/deepseek-v4-flash",
        llmRetrievalModel: "openai/deepseek-v4-flash",
        llmConfigured: false,
        llmMissingFields: ["API key", "Base URL"],
      }),
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="mock-shell">{children}</div>
      ),
    }));

    const module = await import("@/app/chat/page");
    const view = await module.default({
      searchParams: Promise.resolve({ conversationId: "conv_missing" }),
    });
    render(view);

    expect(screen.getByRole("heading", { name: /new chat/i })).toBeInTheDocument();
    expect(screen.getByText(/model service is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /configure model/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(
      screen.getByText(
        /ask across every indexed project, optionally select project scopes/i,
      ),
    ).toBeInTheDocument();
    expect(getConversationDetail).toHaveBeenCalledWith(
      "/tmp/chat-page-test.db",
      "conv_missing",
      "user_demo",
    );
  });

  it("renders the selected project scope in the chat header", async () => {
    const listConversations = vi.fn(() => [
      { id: "conv_1", title: "Quarterly review", scopeLabel: "Alpha" },
    ]);
    const getConversationDetail = vi.fn(() => ({
      id: "conv_1",
      title: "Quarterly review",
      projectIds: ["proj_1"],
      projects: [{ id: "proj_1", name: "Alpha" }],
      messages: [],
    }));
    const listProjects = vi.fn(() => [
      { id: "proj_1", name: "Alpha" },
      { id: "proj_2", name: "Beta" },
    ]);

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/chat-page-test.db",
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));
    vi.doMock("@/lib/repos/conversation-store", () => ({
      listConversations,
      getConversationDetail,
    }));
    vi.doMock("@/lib/repos/project-store", () => ({
      listProjects,
    }));
    vi.doMock("@/lib/repos/system-settings-store", () => ({
      getSystemSettings: () => ({
        indexWorkerConcurrency: 1,
        retrievalDocumentLimit: 5,
        llmApiKeyConfigured: true,
        llmBaseUrl: "https://llm.example.test/v1",
        llmModel: "openai/deepseek-v4-flash",
        llmRetrievalModel: "openai/deepseek-v4-flash",
        llmConfigured: true,
        llmMissingFields: [],
      }),
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="mock-shell">{children}</div>
      ),
    }));

    const module = await import("@/app/chat/page");
    const view = await module.default({
      searchParams: Promise.resolve({ conversationId: "conv_1" }),
    });
    render(view);

    expect(screen.getByRole("heading", { name: /quarterly review/i })).toBeInTheDocument();
    expect(screen.queryByText(/model service is not configured/i)).not.toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Alpha", { selector: "span" })).toBeInTheDocument();
  });
});
