/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentTable } from "@/components/document-table";

describe("DocumentTable", () => {
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
});
