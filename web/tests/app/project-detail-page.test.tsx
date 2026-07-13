/** @vitest-environment jsdom */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createDocumentRecord } from "@/lib/repos/document-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];
const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  router: {
    refresh: vi.fn(),
    push: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => mocks.router,
}));

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-detail-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return { dbPath };
}

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/components/app-shell");
  mocks.notFound.mockClear();
  mocks.router.refresh.mockClear();
  mocks.router.push.mockClear();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ProjectDetailPage", () => {
  it("calls notFound when the project does not exist", async () => {
    const { dbPath } = makeTempDb();

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath,
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));

    const module = await import("@/app/projects/[projectId]/page");

    await expect(
      module.default({
        params: Promise.resolve({ projectId: "proj_missing" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("renders when the project exists", async () => {
    const { dbPath } = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath,
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));

    const module = await import("@/app/projects/[projectId]/page");

    await expect(
      module.default({
        params: Promise.resolve({ projectId: project.id }),
        searchParams: Promise.resolve({}),
      }),
    ).resolves.toBeTruthy();
  });

  it("renders source identity without rename or upload affordances", async () => {
    const { dbPath } = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath,
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }));

    const module = await import("@/app/projects/[projectId]/page");
    const view = await module.default({
      params: Promise.resolve({ projectId: project.id }),
      searchParams: Promise.resolve({}),
    });

    render(view);

    expect(screen.getByText("Alpha source")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload/i })).not.toBeInTheDocument();
  });

  it("renders a search no-match state instead of the empty-document copy", async () => {
    const { dbPath } = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "alpha-spec.pdf",
      storagePath: "/tmp/alpha-spec.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
    });

    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath,
        retrievalBaseUrl: "http://127.0.0.1:8001",
      },
    }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }));

    const module = await import("@/app/projects/[projectId]/page");
    const view = await module.default({
      params: Promise.resolve({ projectId: project.id }),
      searchParams: Promise.resolve({ q: "omega" }),
    });

    render(view);

    expect(screen.getByText(/no matching documents/i)).toBeInTheDocument();
    expect(screen.getByText(/omega/i)).toBeInTheDocument();
    expect(screen.queryByText("No documents found in this project.")).not.toBeInTheDocument();
  });
});
