/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/chat-composer";
import { ChatConversation } from "@/components/chat-conversation";
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
  function streamResponse(events: unknown[]) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

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
          stream: true,
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
          stream: true,
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
          stream: true,
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

  it("sends the message when Enter is pressed in the composer", async () => {
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
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={[]}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, {
      target: { value: "Send with enter" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/send",
      expect.objectContaining({
        body: JSON.stringify({
          conversationId: "conv_new",
          projectIds: [],
          message: "Send with enter",
          mode: "answer",
          stream: true,
        }),
      }),
    );
  });

  it("clears the composer input as soon as a send starts", async () => {
    let resolveSend: ((value: Response) => void) | undefined;
    const sendPromise = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    const fetchMock = vi.fn(() => sendPromise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={[]}
        conversationId="conv_existing"
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, {
      target: { value: "Clear after send" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/send",
      expect.objectContaining({
        body: JSON.stringify({
          conversationId: "conv_existing",
          projectIds: [],
          message: "Clear after send",
          mode: "answer",
          stream: true,
        }),
      }),
    );

    await act(async () => {
      resolveSend?.(
        streamResponse([
          {
            type: "result",
            data: {
              answer: "ok",
              citations: [],
              selectedDocuments: [],
              evidence: [],
            },
          },
        ]),
      );
      await sendPromise;
    });
    await waitFor(() => {
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps Shift+Enter available for multiline input", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={[]}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, {
      target: { value: "Line one" },
    });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not duplicate pending messages after the refreshed conversation includes the sent turn", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      streamResponse([
        {
          type: "result",
          data: {
            answer: "streamed answer",
            citations: [],
            selectedDocuments: [],
            evidence: [],
          },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const conversationProps = {
      availableProjects: [{ id: "proj_1", name: "Alpha" }],
      selectedProjectIds: ["proj_1"],
      conversationId: "conv_existing",
    };

    const { rerender } = render(
      <ChatConversation messages={[]} {...conversationProps} />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Summarize Alpha documents" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("streamed answer")).toBeInTheDocument();
    await waitFor(() => {
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ChatConversation
        messages={[
          {
            id: "msg_user",
            role: "user",
            content: "Summarize Alpha documents",
            citations: [],
          },
          {
            id: "msg_assistant",
            role: "assistant",
            content: "streamed answer",
            citations: [],
          },
        ]}
        {...conversationProps}
      />,
    );

    expect(screen.getAllByText("Summarize Alpha documents")).toHaveLength(1);
    expect(screen.getAllByText("streamed answer")).toHaveLength(1);
  });

  it("shows streamed retrieval progress inside a collapsible assistant response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conv_new" }),
      })
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "progress",
            stage: "documents_loaded",
            data: { documentCount: 2 },
          },
          {
            type: "progress",
            stage: "documents_selected",
            data: {
              documentCount: 1,
              documents: [
                {
                  documentId: "doc_1",
                  documentName: "acceptance.pdf",
                  projectName: "Alpha",
                  sourceRelativePath: "Alpha/acceptance.pdf",
                },
              ],
            },
          },
          {
            type: "result",
            data: {
              answer: "streamed answer",
              citations: [],
              selectedDocuments: [],
              evidence: [],
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatConversation
        messages={[]}
        availableProjects={[{ id: "proj_1", name: "Alpha" }]}
        selectedProjectIds={["proj_1"]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Summarize Alpha documents" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    const assistantMessage = await screen.findByTestId(
      "chat-message-pending-assistant-message",
    );
    const progressMessage = within(assistantMessage).getByTestId("chat-message-progress");
    expect(progressMessage.tagName).toBe("DETAILS");
    expect(progressMessage).not.toHaveAttribute("open");
    expect(assistantMessage).toHaveTextContent(/streamed answer/i);
    expect(progressMessage).toHaveTextContent(/loaded 2 ready documents/i);
    expect(progressMessage).toHaveTextContent(/selected 1 document/i);
    expect(progressMessage).toHaveTextContent(/acceptance\.pdf/i);
    expect(screen.getByText("Summarize Alpha documents")).toBeInTheDocument();
    expect(screen.getByTestId("chat-composer")).not.toHaveTextContent(
      /loaded 2 ready documents/i,
    );
    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith("/chat?conversationId=conv_new");
    });
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
          stream: true,
        }),
      }),
    );
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
              documentUrl: "https://oa.example.test/seeyon/doc.do?docId=doc_1",
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
    expect(screen.getByRole("link", { name: /Q1 Summary\.pdf/i })).toBeVisible();
    expect(
      screen.getByText("Revenue increased after the migration completed."),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Q1 Summary\.pdf/i }),
    ).toHaveAttribute(
      "href",
      "https://oa.example.test/seeyon/doc.do?docId=doc_1",
    );
  });

  it("uses document names instead of opaque source IDs in retrieval progress", () => {
    const document = {
      documentId: "doc_1",
      documentName: "龙田设备档案模板.xlsx",
      projectName: "单位文档",
      sourceRelativePath: "5194972540313029554",
      documentUrl: "https://oa.example.test/seeyon/doc.do?docId=5194972540313029554",
    };

    render(
      <ChatMessageList
        messages={[
          {
            id: "msg_progress",
            role: "assistant",
            content: "回答已生成。",
            citations: [],
            progressExpanded: true,
            progress: {
              documents: [document],
              lines: [
                { id: "started", stage: "document_evidence_started", data: { document } },
                {
                  id: "pages",
                  stage: "document_pages_selected",
                  data: { document, pages: "1-3" },
                },
                { id: "loaded", stage: "document_evidence_loaded", data: { document } },
              ],
            },
          },
        ]}
      />,
    );

    const progress = screen.getByTestId("chat-message-progress");
    expect(progress).toHaveTextContent("Reading 龙田设备档案模板.xlsx.");
    expect(progress).toHaveTextContent("Selected pages 1-3 in 龙田设备档案模板.xlsx.");
    expect(progress).toHaveTextContent("Loaded evidence from 龙田设备档案模板.xlsx.");
    expect(progress).not.toHaveTextContent("5194972540313029554");
    expect(
      screen.getByRole("link", { name: "龙田设备档案模板.xlsx" }),
    ).toHaveAttribute(
      "href",
      "https://oa.example.test/seeyon/doc.do?docId=5194972540313029554",
    );
  });

  it("renders user messages as right-aligned bubbles", () => {
    render(
      <ChatMessageList
        messages={[
          {
            id: "msg_user",
            role: "user",
            content: "How should I write the completion report?",
            citations: [],
          },
          {
            id: "msg_assistant",
            role: "assistant",
            content: "Use the accepted report template.",
            citations: [],
          },
        ]}
      />,
    );

    expect(screen.getByTestId("chat-message-msg_user")).toHaveClass("justify-end");
    expect(screen.getByTestId("chat-message-bubble-msg_user")).toHaveClass(
      "bg-[var(--pi-brand)]",
    );
    expect(screen.getByTestId("chat-message-msg_assistant")).toHaveClass(
      "justify-start",
    );
  });

  it("renders retrieval progress above the assistant answer", () => {
    render(
      <ChatMessageList
        messages={[
          {
            id: "msg_assistant",
            role: "assistant",
            content: "Use the accepted report template.",
            citations: [],
            progress: {
              lines: [
                { id: "line_1", label: "Loaded 2 ready documents." },
                { id: "line_2", label: "Selected 1 document." },
              ],
              documents: [
                {
                  documentId: "doc_1",
                  documentName: "acceptance.pdf",
                  sourceRelativePath: "Alpha/acceptance.pdf",
                },
              ],
            },
          },
        ]}
      />,
    );

    const assistantMessage = screen.getByTestId("chat-message-msg_assistant");
    const progressMessage = within(assistantMessage).getByTestId("chat-message-progress");
    const answer = within(assistantMessage).getByText("Use the accepted report template.");
    expect(progressMessage.tagName).toBe("DETAILS");
    expect(progressMessage).not.toHaveAttribute("open");
    expect(assistantMessage).toHaveTextContent("Use the accepted report template.");
    expect(progressMessage).toHaveTextContent(/loaded 2 ready documents/i);
    expect(progressMessage).toHaveTextContent(/acceptance\.pdf/i);
    expect(
      Boolean(progressMessage.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("renders persisted retrieval progress inside the assistant bubble after refresh", async () => {
    const listConversations = vi.fn(() => [
      { id: "conv_1", title: "Persisted progress", scopeLabel: "Alpha" },
    ]);
    const getConversationDetail = vi.fn(() => ({
      id: "conv_1",
      title: "Persisted progress",
      projectIds: ["proj_1"],
      projects: [{ id: "proj_1", name: "Alpha" }],
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Project background?",
          citations: [],
        },
        {
          id: "msg_assistant",
          role: "assistant",
          content: "The project background is 5G network modernization.",
          citations: [
            {
              kind: "retrieval_progress",
              lines: [
                { stage: "documents_loaded", data: { documentCount: 2 } },
                {
                  stage: "documents_selected",
                  data: {
                    documentCount: 1,
                    documents: [
                      {
                        documentId: "doc_1",
                        documentName: "5G overview.md",
                        projectName: "Alpha",
                        sourceRelativePath: "Alpha/5G overview.md",
                      },
                    ],
                  },
                },
              ],
              documents: [
                {
                  documentId: "doc_1",
                  documentName: "5G overview.md",
                  projectName: "Alpha",
                  sourceRelativePath: "Alpha/5G overview.md",
                },
              ],
            },
            {
              projectId: "proj_1",
              projectName: "Alpha",
              documentId: "doc_1",
              documentName: "5G overview.md",
              pages: "1",
              excerpt: "Project background and requirements analysis",
            },
          ],
        },
      ],
    }));
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
        llmApiKeyConfigured: true,
        llmBaseUrl: "https://llm.example.test/v1",
        llmModel: "openai/deepseek-v4-flash",
        llmRetrievalModel: "openai/deepseek-v4-flash",
        llmConfigured: true,
        llmMissingFields: [],
      }),
    }));
    vi.doMock("@/components/app-shell", async () => {
      const { I18nProvider } =
        await vi.importActual<typeof import("@/lib/i18n")>("@/lib/i18n");
      return {
        AppShell: ({ children }: { children: React.ReactNode }) => (
          <I18nProvider>
            <div data-testid="mock-shell">{children}</div>
          </I18nProvider>
        ),
      };
    });

    const module = await import("@/app/chat/page");
    const view = await module.default({
      searchParams: Promise.resolve({ conversationId: "conv_1" }),
    });
    render(view);

    const assistantMessage = screen.getByTestId("chat-message-msg_assistant");
    const assistantBubble = screen.getByTestId("chat-message-bubble-msg_assistant");
    const progressMessage = within(assistantMessage).getByTestId("chat-message-progress");
    const answer = within(assistantBubble).getByText(
      "The project background is 5G network modernization.",
    );
    const citation = within(assistantBubble).getByText(
      /\[Alpha\] 5G overview\.md - 页 1/i,
    );

    expect(progressMessage).toBeInTheDocument();
    expect(progressMessage).toHaveTextContent(/已加载 2 个就绪文档/);
    expect(progressMessage).toHaveTextContent(/5G overview\.md/i);
    expect(assistantBubble).toHaveClass("bg-white");
    expect(
      Boolean(progressMessage.compareDocumentPosition(citation) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(citation.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("renders persisted retrieval failure progress inside the assistant bubble after refresh", async () => {
    const listConversations = vi.fn(() => [
      { id: "conv_1", title: "Failed progress", scopeLabel: "Alpha" },
    ]);
    const getConversationDetail = vi.fn(() => ({
      id: "conv_1",
      title: "Failed progress",
      projectIds: ["proj_1"],
      projects: [{ id: "proj_1", name: "Alpha" }],
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Project background?",
          citations: [],
        },
        {
          id: "msg_assistant",
          role: "assistant",
          content: "I ran into a retrieval error. Please try again.",
          citations: [
            {
              kind: "retrieval_progress",
              lines: [
                {
                  stage: "retrieval_failed",
                  data: { message: "connect timed out" },
                },
              ],
              documents: [],
            },
          ],
        },
      ],
    }));
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
        llmApiKeyConfigured: true,
        llmBaseUrl: "https://llm.example.test/v1",
        llmModel: "openai/deepseek-v4-flash",
        llmRetrievalModel: "openai/deepseek-v4-flash",
        llmConfigured: true,
        llmMissingFields: [],
      }),
    }));
    vi.doMock("@/components/app-shell", async () => {
      const { I18nProvider } =
        await vi.importActual<typeof import("@/lib/i18n")>("@/lib/i18n");
      return {
        AppShell: ({ children }: { children: React.ReactNode }) => (
          <I18nProvider>
            <div data-testid="mock-shell">{children}</div>
          </I18nProvider>
        ),
      };
    });

    const module = await import("@/app/chat/page");
    const view = await module.default({
      searchParams: Promise.resolve({ conversationId: "conv_1" }),
    });
    render(view);

    const assistantBubble = screen.getByTestId("chat-message-bubble-msg_assistant");
    const progressMessage = within(assistantBubble).getByTestId("chat-message-progress");
    const answer = within(assistantBubble).getByText(
      "I ran into a retrieval error. Please try again.",
    );

    expect(progressMessage).toHaveTextContent(/检索失败/);
    expect(
      Boolean(progressMessage.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
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
                documentUrl: "https://oa.example.test/seeyon/doc.do?docId=doc_2",
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
    expect(screen.getByRole("link", { name: /delivery\/handover\.md/i })).toHaveAttribute(
      "href",
      "https://oa.example.test/seeyon/doc.do?docId=doc_2",
    );
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
    expect(screen.getAllByText("Alpha", { selector: "span" })).toHaveLength(2);
  });
});
