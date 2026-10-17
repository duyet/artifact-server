import {expect, test, type Page} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  artifactSidebar,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const catalogPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()}).passthrough()}).passthrough()),
  nextCursor: z.string().nullable(),
}).passthrough();

const paletteShortcut = "ControlOrMeta+k";

function palette(page: Page) {
  return page.getByRole("dialog", {name: "Command palette"});
}

test.describe("Command palette", () => {
  test("opens on the shortcut, searches the whole project, opens an artifact, and closes on Escape", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const archived = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Archived planning preview</h1></html>",
        idempotencyKey: "palette-archived",
        name: "Quarterly planning archive",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Decision preview</h1></html>",
        idempotencyKey: "palette-decision",
        name: "Decision Board Result",
      });
      await localLogin(fixture);
      // The catalog's first page leaves the archive out, so only a search that
      // reaches the server can find it.
      await fixture.page.route(/\/api\/v1\/artifacts\?.*/u, async (route) => {
        const response = await route.fetch();
        if (new URL(route.request().url()).searchParams.has("search")) {
          await route.fulfill({response});
          return;
        }
        const body = catalogPageSchema.parse(await response.json());
        await route.fulfill({
          body: JSON.stringify({
            ...body,
            artifacts: body.artifacts.filter(({artifact}) => artifact.id !== archived.body.artifact.id),
          }),
          contentType: "application/json",
          response,
        });
      });
      await fixture.page.goto(`${fixture.server.baseUrl}/review?project=prj_default`);
      const tree = artifactSidebar(fixture.page);
      await expect(tree.getByRole("link", {exact: true, name: "Decision Board Result"})).toBeVisible();
      await expect(tree.getByRole("link", {exact: true, name: "Quarterly planning archive"})).toHaveCount(0);

      await fixture.page.keyboard.press(paletteShortcut);
      const dialog = palette(fixture.page);
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole("combobox");
      await expect(input).toBeFocused();
      await expect(dialog.getByRole("option", {exact: true, name: "Settings › MCP"})).toBeVisible();

      await input.fill("quarterly");
      await expect(dialog.getByRole("option", {exact: true, name: "Quarterly planning archive"})).toBeVisible();
      await expect(dialog.getByRole("option", {exact: true, name: "Decision Board Result"})).toHaveCount(0);
      await fixture.page.keyboard.press("Enter");

      await expect(dialog).toBeHidden();
      await expect.poll(() => new URL(fixture.page.url()).searchParams.get("artifact"))
        .toBe(archived.body.artifact.id);
      await expect(fixture.page.getByRole("heading", {exact: true, level: 1, name: "Quarterly planning archive"}))
        .toBeVisible();

      // With an artifact open the palette also offers actions on it.
      await fixture.page.keyboard.press(paletteShortcut);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox").fill("rename");
      await fixture.page.keyboard.press("Enter");
      await expect(fixture.page.getByRole("dialog", {name: "Rename artifact"})).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(fixture.page.getByRole("dialog", {name: "Rename artifact"})).toBeHidden();

      const artifactUrl = fixture.page.url();
      await fixture.page.keyboard.press(paletteShortcut);
      await expect(dialog).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(fixture.page.url()).toBe(artifactUrl);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ignores the shortcut while typing in a textarea or a search box", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review?project=prj_default`);
      const prompt = fixture.page.getByRole("textbox", {name: "Agent connection prompt"});
      await prompt.focus();
      await expect(prompt).toBeFocused();
      await fixture.page.keyboard.press(paletteShortcut);
      await expect(palette(fixture.page)).toBeHidden();

      const search = artifactSidebar(fixture.page).getByRole("searchbox", {name: "Search artifacts"});
      await search.focus();
      await fixture.page.keyboard.press(paletteShortcut);
      await expect(palette(fixture.page)).toBeHidden();

      // Once focus leaves the field the same keys open it.
      await fixture.page.locator("h1").first().click();
      await fixture.page.keyboard.press(paletteShortcut);
      await expect(palette(fixture.page)).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
