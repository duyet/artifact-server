import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Locator, type Page} from "@playwright/test";
import {z} from "zod";

import type {ViewerLogo} from "../../src/core/viewer-logo.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  reviewFrame,
  reviewFrameSelector,
  startBrowserFixture,
  stopBrowserFixture,
  viewerHeader,
  type BrowserFixture,
} from "./browser-fixture.js";

const logoAlt = "Example Org";
const artifactName = "Viewer bar fixture";
const storedArtifactSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    tags: z.array(z.string()),
  }).loose(),
}).loose();

async function fileLogo(): Promise<ViewerLogo> {
  const logoPath = path.join(import.meta.dirname, "fixtures/test-logo.svg");
  const bytes = await readFile(logoPath);
  return {
    alt: logoAlt,
    link: "/",
    source: {
      bytes: new Uint8Array(bytes),
      kind: "file",
      mediaType: "image/svg+xml",
      path: logoPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

async function readStored(fixture: BrowserFixture, artifactId: string) {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}`, {
    headers: {Authorization: `Bearer ${fixture.installation.apiToken}`},
  });
  expect(response.status).toBe(200);
  return storedArtifactSchema.parse(await response.json()).artifact;
}

/** The info popover, opened when it is not already open. */
async function openInfo(page: Page): Promise<Locator> {
  const info = page.getByRole("dialog", {name: "Artifact info"});
  if (!(await info.isVisible())) {
    await viewerHeader(page).getByRole("button", {name: "Artifact info"}).click();
  }
  await expect(info).toBeVisible();
  return info;
}

async function chooseVisibility(page: Page, label: "Private" | "Unlisted"): Promise<void> {
  const info = await openInfo(page);
  await info.getByRole("combobox", {name: "Visibility"}).click();
  await page.getByRole("option", {name: label}).click();
}

test.describe("FRK-026 viewer bar", () => {
  test("FRK-026-B: the bar sits above the preview with the configured logo, the info popover reads the artifact and changes its visibility, and the menu holds the shared actions at desktop and phone width in light and dark", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {
      colorScheme: "light",
      contentDomain: null,
      logo: await fileLogo(),
    });
    try {
      const page = fixture.page;
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: `<!doctype html><html lang="en"><title>${artifactName}</title><main><h1>First version</h1></main></html>`,
        idempotencyKey: "frk-026-browser-first",
        name: artifactName,
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: `<!doctype html><html lang="en"><title>${artifactName}</title><main><h1>Second version</h1></main></html>`,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frk-026-browser-second",
      });
      const views = await Promise.all([1, 2].map(() => fetch(second.body.links.artifact)));
      expect(views.map((response) => response.status)).toEqual([200, 200]);
      await fixture.server.flushArtifactViews();

      await localLogin(fixture);
      await page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
        artifact: first.body.artifact.id,
        project: first.body.artifact.projectId,
        version: second.body.version.id,
      })}`);
      const header = viewerHeader(page);
      await expect(header.getByRole("heading", {exact: true, level: 1, name: artifactName}))
        .toBeVisible();
      await expect(reviewFrame(page).locator("iframe")).toBeAttached();

      const bar = await header.boundingBox();
      const preview = await page.locator(reviewFrameSelector).boundingBox();
      if (bar === null || preview === null) throw new Error("The bar or the preview has no box.");
      expect(bar.height).toBeLessThanOrEqual(44);
      expect(preview.y).toBeGreaterThanOrEqual(bar.y + bar.height);

      const logo = header.getByRole("img", {name: logoAlt});
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate((element) =>
        element instanceof HTMLImageElement ? element.naturalWidth : 0
      )).toBeGreaterThan(0);
      await expect(header.getByRole("link").filter({has: logo})).toHaveAttribute("href", "/");
      await expect(reviewFrame(page).getByRole("button", {name: "Artifact info"}))
        .toHaveCount(0);

      const info = await openInfo(page);
      await expect(info.getByRole("term")).toHaveText([
        "Author",
        "Version",
        "Visibility",
        "Updated",
        "Views",
      ]);
      await expect(info.getByText("v2", {exact: true})).toBeVisible();
      await expect(info.getByRole("combobox", {name: "Visibility"})).toHaveText(/Public/u);
      await expect(info.locator("time")).toHaveAttribute("datetime", second.body.version.createdAt);
      await expect(info.getByRole("img", {name: "2 views in the last 30 days, 2 in all"}))
        .toBeVisible();
      const accessibility = await new AxeBuilder({page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({path: "test-results/browser/viewer-bar-light.png"});

      await chooseVisibility(page, "Unlisted");
      await expect.poll(async () => readStored(fixture, first.body.artifact.id))
        .toMatchObject({accessSetting: "public_link", tags: ["unlisted"]});
      await chooseVisibility(page, "Private");
      await expect.poll(async () => readStored(fixture, first.body.artifact.id))
        .toMatchObject({accessSetting: "account_required", tags: ["unlisted"]});
      await expect((await openInfo(page)).getByRole("combobox", {name: "Visibility"}))
        .toHaveText(/Private/u);

      await page.keyboard.press("Escape");
      await header.getByRole("button", {name: "Artifact actions"}).click();
      await Promise.all(["Copy link", "Versions", "Open raw"].map((name) =>
        expect(page.getByRole("menuitem", {exact: true, name})).toBeVisible()
      ));
      await page.keyboard.press("Escape");

      await page.emulateMedia({colorScheme: "dark"});
      await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
      await openInfo(page);
      await page.screenshot({path: "test-results/browser/viewer-bar-dark.png"});
      await page.keyboard.press("Escape");

      await page.emulateMedia({colorScheme: "light"});
      await page.setViewportSize({height: 844, width: 390});
      await expect(header.getByRole("heading", {level: 1, name: artifactName})).toBeVisible();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth
      )).toBe(true);
      const phoneBar = await header.boundingBox();
      expect(phoneBar?.height).toBeLessThanOrEqual(44);
      await expect(header.getByRole("button", {name: "Full screen"})).toBeHidden();
      await header.getByRole("button", {name: "Artifact actions"}).click();
      await expect(page.getByRole("menuitem", {exact: true, name: "Full screen"})).toBeVisible();
      await expect(page.getByRole("menuitem", {exact: true, name: "Open raw"})).toBeVisible();
      await page.keyboard.press("Escape");
      await page.screenshot({path: "test-results/browser/viewer-bar-phone.png"});
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
