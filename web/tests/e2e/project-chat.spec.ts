import { expect, test } from "@playwright/test";

test("exposes synchronized Projects without demo write controls", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: /^(Projects|项目)$/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /new project|create project|新建项目|创建项目/i }),
  ).toHaveCount(0);

  const projectLinks = page.locator('a[href^="/projects/"]');
  if ((await projectLinks.count()) > 0) {
    await projectLinks.first().click();
    await expect(page.getByRole("button", { name: /upload|rename|上传|重命名/i })).toHaveCount(0);
  }
});
