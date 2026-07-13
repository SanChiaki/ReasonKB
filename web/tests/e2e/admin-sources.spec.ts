import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const passwordFile = process.env.REASONKB_E2E_ADMIN_PASSWORD_FILE;
const hostProjectsRoot = process.env.REASONKB_E2E_PROJECTS_ROOT;
const cleanupPaths: string[] = [];

test.afterEach(() => {
  while (cleanupPaths.length) {
    fs.rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

test("admin manages a runtime manual source through purge without restart", async ({ page }) => {
  test.skip(!passwordFile, "REASONKB_E2E_ADMIN_PASSWORD_FILE is required");
  test.skip(!hostProjectsRoot, "REASONKB_E2E_PROJECTS_ROOT is required");
  const password = fs.readFileSync(passwordFile!, "utf8").trim();
  const suffix = Date.now();
  const sourceName = `Playwright Local ${suffix}`;
  const relativeRoot = `playwright-${suffix}`;
  const hostSourceRoot = path.join(hostProjectsRoot!, relativeRoot);
  const containerSourceRoot = `/data/projects/${relativeRoot}`;
  cleanupPaths.push(hostSourceRoot);
  fs.rmSync(hostSourceRoot, { recursive: true, force: true });

  await page.goto("/admin/login");
  await page.getByLabel("管理员密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin\/sources/);

  await page.evaluate(async () => {
    const csrf = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("reasonkb_admin_csrf="))
      ?.split("=", 2)[1];
    const response = await fetch("/api/admin/sources");
    const payload = await response.json();
    const staleSources = (payload.sources ?? []).filter(
      (source: { displayName?: string }) => source.displayName?.startsWith("Playwright Local "),
    );
    await Promise.all(
      staleSources.map((source: { id: string; displayName: string }) =>
        fetch(`/api/admin/sources/${source.id}`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "x-reasonkb-csrf": decodeURIComponent(csrf ?? ""),
          },
          body: JSON.stringify({ immediate: true, confirmation: source.displayName }),
        }),
      ),
    );
  });

  await page.getByRole("button", { name: "新建数据源" }).click();
  const dialog = page.getByRole("dialog", { name: "新建数据源" });
  await dialog.getByLabel("显示名称").fill(sourceName);
  await dialog.getByLabel("容器内根路径").fill(containerSourceRoot);
  await dialog.getByLabel("同步方式").selectOption("manual");
  await dialog.getByLabel("文件上限（MB）").fill("1");
  await dialog.getByRole("button", { name: "创建" }).click();

  const sourceRow = page.locator("article").filter({ hasText: sourceName });
  await expect(sourceRow).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "刷新" }).click();
        return sourceRow.textContent();
      },
      { timeout: 20_000 },
    )
    .toContain("does not exist");

  fs.mkdirSync(path.join(hostSourceRoot, "Partial"), { recursive: true });
  fs.writeFileSync(
    path.join(hostSourceRoot, "Partial", "ready.md"),
    "# Ready document\n\nThis document proves partial indexing recovery.\n",
  );
  fs.writeFileSync(
    path.join(hostSourceRoot, "Partial", "oversized.md"),
    Buffer.alloc(1024 * 1024 + 1, "x"),
  );
  await sourceRow.getByRole("button", { name: "验证连接" }).click();
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "刷新" }).click();
        return sourceRow.textContent();
      },
      { timeout: 20_000 },
    )
    .toContain("active");

  await sourceRow.getByRole("button", { name: "立即同步" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const sourcesResponse = await fetch("/api/admin/sources");
          const sourcesPayload = await sourcesResponse.json();
          const source = sourcesPayload.sources?.find(
            (candidate: { displayName?: string }) => candidate.displayName === name,
          );
          if (!source) return 0;
          const response = await fetch(`/api/admin/sources/${source.id}/collections`);
          const payload = await response.json();
          return payload.collections?.length ?? 0;
        }, sourceName),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  await sourceRow.locator("button").first().click();
  await sourceRow.getByRole("button", { name: "全选", exact: true }).click();
  await sourceRow.getByRole("button", { name: "立即同步" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const response = await fetch("/api/projects");
          const payload = await response.json();
          return payload.projects?.some(
            (project: { source?: { displayName?: string } }) =>
              project.source?.displayName === name,
          );
        }, sourceName),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const sourcesResponse = await fetch("/api/admin/sources");
          const sourcesPayload = await sourcesResponse.json();
          const source = sourcesPayload.sources?.find(
            (candidate: { displayName?: string }) => candidate.displayName === name,
          );
          if (!source) return null;
          const response = await fetch(`/api/admin/sources/${source.id}/status`);
          const payload = await response.json();
          return {
            total: payload.status?.coverage?.totalDocuments,
            retrievable: payload.status?.coverage?.retrievableDocuments,
            oversized: payload.status?.coverage?.oversizedDocuments,
          };
        }, sourceName),
      { timeout: 30_000 },
    )
    .toEqual({ total: 2, retrievable: 1, oversized: 1 });

  await sourceRow.getByRole("button", { name: "停用" }).click();
  await expect(sourceRow).toContainText("disabled");
  await sourceRow.getByRole("button", { name: "启用并验证" }).click();
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "刷新" }).click();
        return sourceRow.textContent();
      },
      { timeout: 20_000 },
    )
    .toContain("active");

  page.once("dialog", (confirmation) => confirmation.accept());
  await sourceRow.getByRole("button", { name: "移入待清除" }).click();
  await expect(sourceRow).toContainText("pending_purge");
  await sourceRow.getByRole("button", { name: "恢复" }).click();
  await expect(sourceRow).toContainText("disabled");

  page.once("dialog", (confirmation) => confirmation.accept());
  await sourceRow.getByRole("button", { name: "移入待清除" }).click();
  page.once("dialog", (prompt) => prompt.accept(sourceName));
  await sourceRow.getByRole("button", { name: "立即清除" }).click();
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "刷新" }).click();
        return sourceRow.count();
      },
      { timeout: 20_000 },
    )
    .toBe(0);

  await page.getByRole("button", { name: "退出管理" }).click();
  await expect(page).toHaveURL(/\/admin\/login/);
});
