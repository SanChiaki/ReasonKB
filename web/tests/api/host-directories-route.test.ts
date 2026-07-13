import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/security/admin-route-auth");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function mockBrowseRoot() {
  const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rk-host-browse-"));
  tempDirs.push(browseRoot);
  fs.mkdirSync(path.join(browseRoot, "Workspace", "ReasonKB"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(browseRoot, "Archives"));
  fs.writeFileSync(path.join(browseRoot, "notes.txt"), "not a directory");
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      hostBrowseRootContainerPath: browseRoot,
      hostBrowseRootHostPath: "/Users/oam",
    },
  }));
  vi.doMock("@/lib/security/admin-route-auth", () => ({
    authorizeAdminRequest: () => ({ id: "test-admin" }),
    unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
  }));
  return browseRoot;
}

describe("host directories route", () => {
  it("lists host directories through the configured read-only browse mount", async () => {
    mockBrowseRoot();

    const { GET } = await import("@/app/api/admin/host-directories/route");
    const response = await GET(
      new Request("http://localhost/api/admin/host-directories?path=/"),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      rootHostPath: "/Users/oam",
      currentBrowsePath: "/",
      currentHostPath: "/Users/oam",
      parentBrowsePath: null,
      entries: [
        {
          name: "Archives",
          browsePath: "/Archives",
          hostPath: "/Users/oam/Archives",
        },
        {
          name: "Workspace",
          browsePath: "/Workspace",
          hostPath: "/Users/oam/Workspace",
        },
      ],
    });
  });

  it("maps nested browse paths back to absolute host paths", async () => {
    mockBrowseRoot();

    const { GET } = await import("@/app/api/admin/host-directories/route");
    const response = await GET(
      new Request(
        "http://localhost/api/admin/host-directories?path=%2FWorkspace",
      ),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.currentBrowsePath).toBe("/Workspace");
    expect(json.currentHostPath).toBe("/Users/oam/Workspace");
    expect(json.parentBrowsePath).toBe("/");
    expect(json.entries).toEqual([
      {
        name: "ReasonKB",
        browsePath: "/Workspace/ReasonKB",
        hostPath: "/Users/oam/Workspace/ReasonKB",
      },
    ]);
  });

  it("rejects traversal outside the configured browse root", async () => {
    mockBrowseRoot();

    const { GET } = await import("@/app/api/admin/host-directories/route");
    const response = await GET(
      new Request(
        "http://localhost/api/admin/host-directories?path=%2F..%2Fsecret",
      ),
    );

    expect(response.status).toBe(400);
  });

  it("returns unavailable when no host browse root is configured", async () => {
    vi.doMock("@/lib/security/admin-route-auth", () => ({
      authorizeAdminRequest: () => ({ id: "test-admin" }),
      unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
    }));
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        hostBrowseRootContainerPath: "",
        hostBrowseRootHostPath: "",
      },
    }));

    const { GET } = await import("@/app/api/admin/host-directories/route");
    const response = await GET(
      new Request("http://localhost/api/admin/host-directories?path=/"),
    );

    expect(response.status).toBe(503);
  });
});
