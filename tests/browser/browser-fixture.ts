import {
  expect,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

import type {BrowserAccess} from "../../src/core/browser-access.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

/** One browser test's own installation, server, and signed-in page. */
export interface BrowserFixture {
  readonly context: BrowserContext;
  readonly installation: TestInstallation;
  readonly page: Page;
  readonly server: RunningTestServer;
}

export async function startBrowserFixture(
  browser: Browser,
  options: {
    readonly browserAccess?: BrowserAccess;
    readonly contentDomain?: string | null;
    readonly timezoneId?: string;
  } = {},
): Promise<BrowserFixture> {
  const {browserAccess, contentDomain, ...contextOptions} = options;
  const installation = await createTestInstallation();
  let serverOptions: Parameters<typeof startTestServer>[1] = {};
  if (browserAccess !== undefined) serverOptions = {...serverOptions, browserAccess};
  if (contentDomain !== undefined) serverOptions = {...serverOptions, contentDomain};
  const server = await startTestServer(installation, serverOptions);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return {context, installation, page, server};
}

export async function stopBrowserFixture(fixture: BrowserFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

export async function localLogin(
  fixture: BrowserFixture,
  waitForApplication = true,
): Promise<void> {
  // `/` is the public home page now, so sign-in tests open Review by name.
  await fixture.page.goto(`${fixture.server.baseUrl}/review`);
  if (waitForApplication) {
    await expect(fixture.page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
    await expect(fixture.page).toHaveURL(/\/review\?project=prj_default/u);
  }
}

export async function closeTopDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

/** Everything this application is forbidden to keep in the browser. */
export async function browserStorage(page: Page): Promise<{
  readonly indexedDatabaseNames: readonly string[];
  readonly localStorageKeys: readonly string[];
  readonly sessionStorageKeys: readonly string[];
}> {
  return page.evaluate(async () => ({
    indexedDatabaseNames: (await indexedDB.databases())
      .map((database) => database.name)
      .filter((name): name is string => name !== undefined),
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
  }));
}

/** CSS selector for the frame that hosts an artifact's HTML preview. */
export const reviewFrameSelector = 'iframe[src="/review-frame"]';

/** The review frame that hosts an artifact's HTML preview. */
export function reviewFrame(page: Page): FrameLocator {
  return page.frameLocator(reviewFrameSelector);
}

/** The sandboxed artifact document inside the review frame. */
export function artifactPreview(page: Page): FrameLocator {
  return reviewFrame(page).frameLocator("iframe");
}

/** The sidebar's navigation landmark: destinations and the artifact tree. */
export function artifactSidebar(page: Page): Locator {
  return page.getByRole("navigation", {name: "Artifact catalog"});
}

/** The sidebar container whose `data-state` is "expanded" or "collapsed". */
export function sidebarState(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}

/** The header button that shows or hides the sidebar (the rail has the same name). */
export function sidebarToggle(page: Page): Locator {
  return page.locator('[data-slot="sidebar-trigger"]');
}

/** The viewer's top bar: the header that holds the artifact's name. */
export function viewerHeader(page: Page): Locator {
  return page.locator("header").filter({has: page.getByRole("heading", {level: 1})});
}

/** One artifact's row on the Artifacts gallery. */
export function galleryRow(page: Page, name: string): Locator {
  return page.locator("#main-content li").filter({
    has: page.getByRole("link", {exact: true, name}),
  });
}

/** Every artifact row on the Artifacts gallery, in display order. */
export function galleryRows(page: Page): Locator {
  return page.locator("#main-content li").filter({
    has: page.getByRole("button", {name: /^Actions for /u}),
  });
}

/** Open an artifact from the gallery by its row link. */
export async function openArtifactFromGallery(page: Page, name: string): Promise<void> {
  await page.locator("#main-content").getByRole("link", {exact: true, name}).click();
  await expect(page.getByRole("heading", {exact: true, level: 1, name})).toBeVisible();
}

/** Run one item of the sidebar's account menu. */
export async function chooseAccountMenuItem(page: Page, name: string): Promise<void> {
  await page.getByRole("button", {name: /^Account:/u}).click();
  await page.getByRole("menuitem", {exact: true, name}).click();
  // The menu animates out before it unmounts; callers inspect the settled page.
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);
}

function escapeRegularExpression(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * Select one file in the inspector's Files tab, opening its folders first.
 * Only folders on the selected path start open, so every other file sits
 * behind a folder button.
 */
export async function selectInspectorFile(page: Page, path: string): Promise<void> {
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? path;
  const inspector = page.getByRole("complementary", {name: "Artifact inspector"});
  for (const folder of segments.slice(0, -1)) {
    const folderButton = inspector.getByRole("button", {exact: true, name: folder});
    // eslint-disable-next-line no-await-in-loop
    if ((await folderButton.getAttribute("aria-expanded")) !== "true") {
      // eslint-disable-next-line no-await-in-loop
      await folderButton.click();
    }
  }
  // A file button's name is "<file name> <size>".
  await inspector.getByRole("button", {
    name: new RegExp(`^${escapeRegularExpression(fileName)}`, "u"),
  }).click();
}
