import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Frame, type Page} from "@playwright/test";
import {z} from "zod";

import {publishSite} from "../support/same-host-site.js";
import {
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

const artifactName = "Readable viewer fixture";
const readablePath = "2026/10/readable-viewer";
// The stylesheet the site helper publishes at ./assets/a.css paints the body
// rebeccapurple, so the computed color proves the relative URL resolved.
const entry = [
  '<!doctype html><html lang="en"><head><title>Readable page</title>',
  '<link rel="stylesheet" href="./assets/a.css"></head>',
  '<body><main><h1>Readable page</h1><a href="#end">Jump to the end</a>',
  '<div style="height: 3000px"></div><p id="end">The end</p></main></body></html>',
].join("");
const treeSchema = z.object({
  artifacts: z.array(z.object({
    name: z.string(),
    views: z.object({total: z.number().int().nonnegative()}).loose(),
  }).loose()),
}).loose();

function viewerBar(page: Page) {
  return page.getByRole("banner", {name: "Artifact viewer"});
}

/** The sandboxed frame that holds the artifact's page, once it has loaded. */
async function pageFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes("raw=1")))
    .toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().includes("raw=1"));
  if (frame === undefined) throw new Error("The viewer has no page frame.");
  await frame.waitForLoadState();
  return frame;
}

async function totalViews(fixture: BrowserFixture): Promise<number> {
  await fixture.server.flushArtifactViews();
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/public/tree`);
  const listed = treeSchema.parse(await response.json()).artifacts
    .find((artifact) => artifact.name === artifactName);
  return listed?.views.total ?? 0;
}

async function fitsWidth(page: Page) {
  return page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= window.innerWidth,
    pastRightEdge: [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 120))
      .slice(0, 8),
  }));
}

test.describe("FRK-029 readable URL viewer", () => {
  test("FRK-029-B: a readable URL shows the bar above the framed page, whose relative stylesheet and anchors work, with read-only info for an anonymous reader, one view, a remembered hide control, and phone width in light and dark", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {colorScheme: "light", contentDomain: null});
    try {
      const page = fixture.page;
      await publishSite(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        entry,
        name: artifactName,
        path: readablePath,
      });
      const readableUrl = `${fixture.server.baseUrl}/${readablePath}/`;

      await page.goto(readableUrl);
      const bar = viewerBar(page);
      await expect(bar.getByRole("heading", {exact: true, level: 1, name: artifactName}))
        .toBeVisible();
      await expect(page).toHaveTitle(artifactName);
      const frameElement = page.locator(`iframe[title="${artifactName}"]`);
      await expect(frameElement).toHaveAttribute("sandbox", /allow-scripts/u);
      await expect(frameElement).not.toHaveAttribute("sandbox", /allow-same-origin/u);

      const frame = await pageFrame(page);
      expect(new URL(frame.url()).pathname).toBe(`/${readablePath}/`);
      await expect(frame.getByRole("heading", {name: "Readable page"})).toBeVisible();
      await expect.poll(() => frame.evaluate(() => getComputedStyle(document.body).color))
        .toBe("rgb(102, 51, 153)");
      expect(await frame.evaluate(() => {
        try {
          return window.parent.document.title;
        } catch {
          return "blocked";
        }
      })).toBe("blocked");
      await frame.getByRole("link", {name: "Jump to the end"}).click();
      await expect.poll(() => frame.evaluate(() => location.hash)).toBe("#end");
      await expect(bar).toBeVisible();

      const barBox = await bar.boundingBox();
      const frameBox = await frameElement.boundingBox();
      if (barBox === null || frameBox === null) throw new Error("The bar or the frame has no box.");
      expect(barBox.height).toBeLessThanOrEqual(44);
      expect(frameBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);

      expect(await totalViews(fixture)).toBe(1);

      await bar.getByRole("button", {name: "Artifact info"}).click();
      const info = page.getByRole("dialog", {name: "Artifact info"});
      await expect(info.getByRole("term")).toHaveText([
        "Author",
        "Version",
        "Visibility",
        "Updated",
        "Views",
      ]);
      await expect(info.getByText("v1", {exact: true})).toBeVisible();
      await expect(info.getByRole("combobox", {name: "Visibility"})).toHaveCount(0);
      await expect(info.getByText("Public", {exact: true})).toBeVisible();
      const accessibility = await new AxeBuilder({page})
        .exclude(`iframe[title="${artifactName}"]`)
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({path: "test-results/browser/readable-viewer-light.png"});
      await page.keyboard.press("Escape");

      await bar.getByRole("button", {name: "Artifact actions"}).click();
      await Promise.all(["Copy link", "Open raw", "Full screen"].map((name) =>
        expect(page.getByRole("menuitem", {exact: true, name})).toBeVisible()
      ));
      await expect(page.getByRole("menuitem", {name: "Open in Review"})).toHaveCount(0);
      await page.keyboard.press("Escape");

      await page.emulateMedia({colorScheme: "dark"});
      await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
      await page.screenshot({path: "test-results/browser/readable-viewer-dark.png"});
      await page.emulateMedia({colorScheme: "light"});

      await page.setViewportSize({height: 844, width: 390});
      await expect(bar.getByRole("heading", {level: 1, name: artifactName})).toBeVisible();
      await expect.poll(() => fitsWidth(page)).toMatchObject({fits: true});
      expect((await bar.boundingBox())?.height).toBeLessThanOrEqual(44);
      await page.screenshot({path: "test-results/browser/readable-viewer-phone.png"});

      await bar.getByRole("button", {name: "Hide bar"}).click();
      await expect(bar).toHaveCount(0);
      expect((await frameElement.boundingBox())?.y).toBe(0);
      await page.reload();
      await expect(page.getByRole("button", {name: "Show bar"})).toBeVisible();
      await expect(viewerBar(page)).toHaveCount(0);
      await page.getByRole("button", {name: "Show bar"}).click();
      await expect(viewerBar(page)).toBeVisible();
      await page.reload();
      await expect(viewerBar(page)).toBeVisible();

      await viewerBar(page).getByRole("button", {name: "Artifact actions"}).click();
      await page.getByRole("menuitem", {exact: true, name: "Open raw"}).click();
      await expect(page).toHaveURL(`${readableUrl}?raw=1`);
      await expect(page.getByRole("heading", {level: 1, name: "Readable page"})).toBeVisible();
      await expect(viewerBar(page)).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
