import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("formal product write-surface hardening", () => {
  it("exposes Projects as read-only API resources", async () => {
    const projectsRoute = await import("@/app/api/projects/route");
    const projectRoute = await import("@/app/api/projects/[projectId]/route");

    expect(projectsRoute.GET).toBeTypeOf("function");
    expect("POST" in projectsRoute).toBe(false);
    expect(projectRoute.GET).toBeTypeOf("function");
    expect("PATCH" in projectRoute).toBe(false);
    expect("DELETE" in projectRoute).toBe(false);
  });

  it("does not ship manual Project or upload implementation files", () => {
    const webRoot = path.resolve(process.cwd());
    const removedPaths = [
      "components/project-create-form.tsx",
      "components/project-rename-control.tsx",
      "components/document-upload-modal.tsx",
      "app/api/projects/[projectId]/documents/upload/route.ts",
      "lib/storage/local-files.ts",
    ];

    for (const relativePath of removedPaths) {
      expect(fs.existsSync(path.join(webRoot, relativePath))).toBe(false);
    }
  });
});
