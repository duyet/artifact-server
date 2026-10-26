import {expect, test} from "@playwright/test";

import {publishSite} from "../support/same-host-site.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

test.describe("folder default state on the home page", () => {
  test("FRK-021-B: a folder set collapsed starts closed, other folders start open, and the viewer can still open it", async ({page}) => {
    const installation = await createTestInstallation();
    const server = await startTestServer(installation, {contentDomain: null});
    try {
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Old report",
        path: "team/archive/old-report",
      });
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Agent console",
        path: "2026/10/agent-console",
      });
      const set = await fetch(`${server.baseUrl}/api/v1/folder-defaults`, {
        body: JSON.stringify({defaultState: "collapsed", path: "team/archive"}),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "PUT",
      });
      expect(set.status).toBe(200);

      await page.goto(server.baseUrl);
      const archive = page.getByRole("button", {name: "team/archive"});
      await expect(archive).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("link", {name: "Old report"})).toBeHidden();
      await expect(page.getByRole("button", {name: "2026/10"}))
        .toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("link", {name: "Agent console"})).toBeVisible();

      await archive.click();
      await expect(archive).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("link", {name: "Old report"})).toBeVisible();
      await archive.click();
      await expect(page.getByRole("link", {name: "Old report"})).toBeHidden();
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});
