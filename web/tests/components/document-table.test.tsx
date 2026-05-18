/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentTable } from "@/components/document-table";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

describe("DocumentTable", () => {
  beforeEach(() => {
    routerMocks.refresh.mockClear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders source paths and latest parse metrics", () => {
    render(
      <DocumentTable
        documents={[
          {
            id: "doc_1",
            fileName: "handover.md",
            pageCount: 1,
            status: "ready",
            createdAt: "2026-04-25T10:00:00.000Z",
            projectRelativePath: "delivery/handover.md",
            lastIndexDurationMs: 1530,
            lastIndexTotalTokens: 4200,
            lastIndexLlmCallCount: 6,
          },
        ]}
      />,
    );

    expect(screen.getByText("delivery/handover.md")).toBeInTheDocument();
    expect(screen.getByText("1.5s")).toBeInTheDocument();
    expect(screen.getByText("4.2K tokens")).toBeInTheDocument();
    expect(screen.getByText("6 calls")).toBeInTheDocument();
  });

  it("renders failed and skipped document reasons", () => {
    render(
      <DocumentTable
        documents={[
          {
            id: "doc_failed",
            fileName: "broken.docx",
            pageCount: 0,
            status: "failed",
            errorMessage: "Failed to complete toc transformation after maximum retries",
            createdAt: "2026-04-25T10:00:00.000Z",
          },
          {
            id: "doc_skipped",
            fileName: "archive.zip",
            pageCount: 0,
            status: "skipped",
            importError: "Unsupported file type: .zip",
            createdAt: "2026-04-25T10:00:00.000Z",
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Failed to complete toc transformation after maximum retries"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unsupported file type: .zip")).toBeInTheDocument();
  });

  it("queues reindex for a document and refreshes the table", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "job_1", status: "queued" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onReindexQueued = vi.fn();

    render(
      <DocumentTable
        documents={[
          {
            id: "doc_failed",
            fileName: "broken.docx",
            pageCount: 0,
            status: "failed",
            errorMessage: "KeyError: page_index_given_in_toc",
            createdAt: "2026-04-25T10:00:00.000Z",
          },
        ]}
        onReindexQueued={onReindexQueued}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reindex broken\.docx/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/documents/doc_failed/reindex", {
        method: "POST",
      });
    });
    expect(onReindexQueued).toHaveBeenCalledTimes(1);
    expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("opens a stored PageIndex tree for a single document", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        documentId: "doc_ready",
        indexedAt: "2026-05-18T10:00:00.000Z",
        stats: {
          nodeCount: 2,
          leafCount: 1,
          maxDepth: 1,
        },
        roots: [
          {
            id: "0000",
            title: "总体设计",
            summary: "总体设计摘要",
            pageRange: "1-3",
            depth: 0,
            children: [
              {
                id: "0001",
                title: "网络规划",
                summary: "网络规划摘要",
                pageRange: "2-3",
                depth: 1,
                children: [],
              },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DocumentTable
        documents={[
          {
            id: "doc_ready",
            fileName: "alpha.pdf",
            pageCount: 3,
            status: "ready",
            createdAt: "2026-04-25T10:00:00.000Z",
            hasIndexTree: true,
            indexNodeCount: 2,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view index tree for alpha\.pdf/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/documents/doc_ready/structure");
    });
    expect(screen.getByRole("dialog", { name: /pageindex tree for alpha\.pdf/i })).toBeInTheDocument();
    expect(screen.getByText("2 nodes")).toBeInTheDocument();
    expect(screen.getByText("总体设计")).toBeInTheDocument();
    expect(screen.getByText("网络规划")).toBeInTheDocument();
  });

  it("disables the PageIndex tree action until an index exists", () => {
    render(
      <DocumentTable
        documents={[
          {
            id: "doc_queued",
            fileName: "queued.pdf",
            pageCount: 0,
            status: "uploaded",
            createdAt: "2026-04-25T10:00:00.000Z",
            hasIndexTree: false,
            indexNodeCount: 0,
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /index tree unavailable for queued\.pdf/i })).toBeDisabled();
  });
});
