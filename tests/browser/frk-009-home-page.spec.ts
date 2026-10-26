import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Browser, type Page} from "@playwright/test";

import {publishVersion} from "../support/publishing.js";
import {publishSite} from "../support/same-host-site.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

/**
 * The home page is the fork's landing page for a viewer on the VPN, so it is
 * captured in both themes. These are the only browser cases in this work; they
 * run in CI because the development machine has no browsers.
 */
test.describe("public home page", () => {
  test("the tree, the totals, and the charts render in both themes with no accessibility violations", async ({browser}) => {
    const installation = await createTestInstallation();
    const server = await startTestServer(installation, {contentDomain: null});
    try {
      await publishFixture(server, installation);
      await capture(browser, server, "dark");
      await capture(browser, server, "light");
      await chooseTheme(browser, server);
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
    }
  });

  test("FRK-023-B: the chart switches between views and updates, and a day's bar filters the tree by mouse and keyboard", async ({browser}) => {
    const installation = await createTestInstallation();
    // The page draws the window that ends on the browser's UTC today, so the
    // server clock stays on the real day and steps back one day by hand.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const clock = {instant: yesterday, now() {
      return this.instant;
    }};
    const server = await startTestServer(installation, {clock, contentDomain: null});
    const context = await browser.newContext({colorScheme: "light"});
    try {
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Capacity plan",
        path: "2026/11/capacity-plan",
      });
      clock.instant = today;
      const agentConsole = await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Agent console",
        path: "2026/10/agent-console",
      });
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Incident summary",
      });
      const revised = await publishVersion(server, installation, {
        artifactId: agentConsole.artifact.id,
        content: "<!doctype html><title>Agent console v2</title>",
        expectedCurrentVersionId: agentConsole.version.id,
        idempotencyKey: "frk-009-browser-console-v2",
      });
      expect(revised.response.status).toBe(201);
      // A folder that starts collapsed must still open while a day filter
      // matches inside it.
      const collapsed = await fetch(`${server.baseUrl}/api/v1/folder-defaults`, {
        body: JSON.stringify({defaultState: "collapsed", path: "2026/11"}),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "PUT",
      });
      expect(collapsed.status).toBe(200);
      await fetch(`${server.baseUrl}/2026/10/agent-console/`);
      await fetch(`${server.baseUrl}/2026/10/agent-console/`);
      await server.flushArtifactViews();

      const page = await context.newPage();
      await page.clock.setFixedTime(today);
      await page.goto(server.baseUrl);
      await expect(page.getByText("Views per day")).toBeVisible();
      const todayLabel = dayLabel(today);
      const yesterdayLabel = dayLabel(yesterday);

      // Views: a click on today's bar keeps only the viewed artifact and the
      // folders above it.
      const viewedToday = page.getByRole("button", {name: `${todayLabel}: 2 views`});
      const todayBar = page.locator("[data-slot=chart] .recharts-bar-rectangle").last();
      await expectColumnCovers(viewedToday, todayBar);
      await todayBar.click();
      await expect(viewedToday).toHaveAttribute("aria-pressed", "true");
      const viewedChip = page.getByRole("button", {name: `Viewed on ${todayLabel}, clear`});
      await expect(viewedChip).toBeVisible();
      await expect(visibleArtifacts(page)).toHaveText(["Agent console"]);
      await expect(page.getByRole("heading", {name: "2026/10"})).toBeVisible();
      await expect(page.getByRole("heading", {name: "2026/11"})).toHaveCount(0);
      await expect(page.getByRole("heading", {name: "Without a path"})).toHaveCount(0);
      const violations = await new AxeBuilder({page}).analyze();
      expect(violations.violations).toEqual([]);
      await page.screenshot({
        fullPage: true,
        path: "test-results/browser/home-page-viewed-filter.png",
      });

      // The same bar again clears the filter.
      await todayBar.click();
      await expect(viewedChip).toHaveCount(0);
      await expect(viewedToday).toHaveAttribute("aria-pressed", "false");
      await expect(visibleArtifacts(page)).toHaveText(["Agent console", "Incident summary"]);

      // Updates: the chart now counts versions, and a day narrows the tree to
      // what was published on it.
      await page.getByRole("button", {exact: true, name: "Updated"}).click();
      await expect(page.getByText("Updated per day")).toBeVisible();
      const updatedToday = page.getByRole("button", {name: `${todayLabel}: 3 versions`});
      const updatedYesterday = page.getByRole("button", {name: `${yesterdayLabel}: 1 version`});
      await expect(updatedYesterday).toBeVisible();

      // The keyboard path: one tab stop on the newest day, arrows to move,
      // Enter or Space to toggle.
      await updatedToday.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(updatedYesterday).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(updatedYesterday).toHaveAttribute("aria-pressed", "true");
      const updatedChip = page.getByRole("button", {name: `Updated on ${yesterdayLabel}, clear`});
      await expect(updatedChip).toBeVisible();
      await expect(visibleArtifacts(page)).toHaveText(["Capacity plan"]);
      await expect(page.getByRole("button", {name: "2026/11"}))
        .toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("heading", {name: "2026/10"})).toHaveCount(0);
      await page.screenshot({
        fullPage: true,
        path: "test-results/browser/home-page-updated-filter.png",
      });
      await page.keyboard.press("Enter");
      await expect(updatedChip).toHaveCount(0);
      // Without the filter the folder returns to its collapsed default.
      await expect(page.getByRole("button", {name: "2026/11"}))
        .toHaveAttribute("aria-expanded", "false");

      await page.keyboard.press("ArrowRight");
      await expect(updatedToday).toBeFocused();
      await page.keyboard.press("Space");
      await expect(visibleArtifacts(page)).toHaveText(["Agent console", "Incident summary"]);
      // The chip clears too, and hands focus back to the day it named.
      await page.getByRole("button", {name: `Updated on ${todayLabel}, clear`}).click();
      await expect(visibleArtifacts(page)).toHaveText(["Agent console", "Incident summary"]);
      await expect(updatedToday).toBeFocused();
    } finally {
      await context.close();
      await server.stop();
      await removeTestInstallation(installation);
    }
  });

  test("FRK-025-B: each measure wears its accent, a selected day keeps it while the rest tint, hover and focus show the day's tooltip, and today is marked", async ({browser}) => {
    const installation = await createTestInstallation();
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const clock = {instant: yesterday, now() {
      return this.instant;
    }};
    const server = await startTestServer(installation, {clock, contentDomain: null});
    try {
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Agent console",
        path: "2026/10/agent-console",
      });
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: "Cost report",
        path: "2026/10/cost-report",
      });
      await fetch(`${server.baseUrl}/2026/10/agent-console/`);
      await fetch(`${server.baseUrl}/2026/10/agent-console/`);
      await server.flushArtifactViews();
      clock.instant = today;
      await fetch(`${server.baseUrl}/2026/10/agent-console/`);
      await fetch(`${server.baseUrl}/2026/10/cost-report/`);
      await server.flushArtifactViews();

      // One theme after the other: both share the server and its counts.
      await expectChartTones(browser, server, "light", today, yesterday);
      await expectChartTones(browser, server, "dark", today, yesterday);
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});

/**
 * The chart's tones, tooltip, summary, and today's mark in one theme, with a
 * screenshot of each measure's card.
 */
async function expectChartTones(
  browser: Browser,
  server: RunningTestServer,
  theme: "dark" | "light",
  today: Date,
  yesterday: Date,
): Promise<void> {
  const todayLabel = dayLabel(today);
  const yesterdayLabel = dayLabel(yesterday);
  const context = await browser.newContext({colorScheme: theme});
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(today);
    await page.goto(server.baseUrl);
    await expect(page.locator("html")).toHaveClass(new RegExp(String.raw`\b${theme}\b`, "u"));
    // A day with no count draws no path, so in views the only two marks are
    // yesterday's and today's.
    const marks = page.locator("[data-slot=chart] .recharts-bar-rectangle path");
    const yesterdayBar = marks.first();
    const todayBar = marks.last();
    const tooltip = page.locator("[data-slot=chart-tooltip]");
    const views = await toneColours(page, "--chart-views");

    // The summary counts the window and names the busiest day; a tie
    // goes to the latest one.
    await expect(page.locator("[data-slot=chart-summary]"))
      .toHaveText(`4 views in 30 days, busiest on ${todayLabel} with 2`);

    // With no day selected every bar wears the accent.
    expect(await fillOf(todayBar)).toBe(views.full);
    expect(await fillOf(yesterdayBar)).toBe(views.full);

    // Hover steps a bar down and shows its date and count.
    await yesterdayBar.hover();
    await expect(tooltip).toHaveText(`${yesterdayLabel}2 views`);
    expect(await fillOf(yesterdayBar)).toBe(views.hover);

    // A selected day keeps the accent and the rest recede to the tint.
    await todayBar.click();
    await expect(tooltip).toHaveText(`Today, ${todayLabel}2 views`);
    await page.getByRole("heading", {name: "Artifact Server"}).hover();
    await expect(tooltip).toHaveCount(0);
    await expect.poll(() => fillOf(yesterdayBar)).toBe(views.muted);
    expect(await fillOf(todayBar)).toBe(views.full);

    // Keyboard focus shows the same tooltip as hover, and wins over a
    // pointer resting on another day.
    await todayBar.hover();
    await expect(tooltip).toHaveText(`Today, ${todayLabel}2 views`);
    await page.getByRole("button", {name: `${todayLabel}: 2 views`}).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("button", {name: `${yesterdayLabel}: 2 views`})).toBeFocused();
    await expect(tooltip).toHaveText(`${yesterdayLabel}2 views`);
    expect(await fillOf(yesterdayBar)).toBe(views.hover);

    // Today's dot sits under today's column.
    const dot = await page.locator("[data-slot=chart-today]").boundingBox();
    const column = await page.getByRole("button", {name: `${todayLabel}: 2 views`}).boundingBox();
    if (dot === null || column === null) throw new Error("Today's dot or column is not drawn.");
    expect(dot.x + dot.width / 2).toBeGreaterThan(column.x);
    expect(dot.x + dot.width / 2).toBeLessThan(column.x + column.width);

    // Each bar sits inside its own day's button, so a y axis that changes
    // width and shifts the bars is caught.
    await expectColumnCovers(page.getByRole("button", {name: `${yesterdayLabel}: 2 views`}), yesterdayBar);
    await expectColumnCovers(page.getByRole("button", {name: `${todayLabel}: 2 views`}), todayBar);

    const violations = await new AxeBuilder({page}).analyze();
    expect(violations.violations).toEqual([]);
    await page.locator("[data-slot=card]").filter({hasText: "Views per day"}).screenshot({
      path: `test-results/browser/home-chart-views-${theme}.png`,
    });

    // The other measure wears its own accent.
    await page.getByRole("button", {exact: true, name: "Updated"}).click();
    await expect(page.getByText("Updated per day")).toBeVisible();
    const updates = await toneColours(page, "--chart-updates");
    expect(updates.full).not.toBe(views.full);
    // Both artifacts were published yesterday, so that is the only bar.
    await expect.poll(() => fillOf(yesterdayBar)).toBe(updates.full);
    await yesterdayBar.hover();
    await expect(tooltip).toHaveText(`${yesterdayLabel}2 versions`);
    expect(await fillOf(yesterdayBar)).toBe(updates.hover);
    await page.locator("[data-slot=card]").filter({hasText: "Updated per day"}).screenshot({
      path: `test-results/browser/home-chart-updates-${theme}.png`,
    });
  } finally {
    await context.close();
  }
}

/** The computed colour each bar tone resolves to for one measure's accent. */
async function toneColours(page: Page, accent: "--chart-updates" | "--chart-views") {
  const [full = "", hover = "", muted = ""] = await page.evaluate((values) =>
    values.map((value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }), [
    `var(${accent})`,
    `color-mix(in oklab, var(${accent}) 90%, var(--card))`,
    `color-mix(in oklab, var(${accent}) 80%, var(--card))`,
  ]);
  return {full, hover, muted};
}

async function fillOf(mark: ReturnType<Page["locator"]>): Promise<string> {
  return mark.evaluate((element) => getComputedStyle(element).fill);
}

/** The day as the page prints it: "26 Oct", on the UTC calendar. */
function dayLabel(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(instant);
}

/** The artifact links the tree currently shows, in page order. */
function visibleArtifacts(page: Page) {
  return page.getByRole("main").getByRole("link").filter({hasNotText: "Workbench"});
}

/** A day's keyboard target must sit over the bar it names. */
async function expectColumnCovers(
  dayButton: ReturnType<Page["locator"]>,
  bar: ReturnType<Page["locator"]>,
): Promise<void> {
  const column = await dayButton.boundingBox();
  const mark = await bar.boundingBox();
  if (column === null || mark === null) throw new Error("The day column or its bar is not drawn.");
  const centre = mark.x + mark.width / 2;
  expect(centre).toBeGreaterThan(column.x);
  expect(centre).toBeLessThan(column.x + column.width);
}

/** Publish one artifact per month, plus one with no readable path. */
async function publishFixture(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<void> {
  const paths: readonly {name: string; path: string}[] = [
    {name: "Agent console", path: "2026/10/agent-console"},
    {name: "Cost report", path: "2026/10/cost-report"},
    {name: "Capacity plan", path: "2026/11/capacity-plan"},
  ];
  await Promise.all([
    ...paths.map(async (input) => {
      await publishSite(server, installation, {
        accessSetting: "public_link",
        name: input.name,
        path: input.path,
      });
    }),
    // One artifact claims no readable path, so the page's ungrouped list has
    // something in it.
    publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Incident summary",
    }),
  ]);

  // Real views, so the counters and both charts have something to draw.
  await Promise.all([
    fetch(`${server.baseUrl}/2026/10/agent-console/`),
    fetch(`${server.baseUrl}/2026/10/agent-console/`),
    fetch(`${server.baseUrl}/2026/10/agent-console/`),
    fetch(`${server.baseUrl}/2026/10/agent-console/`),
    fetch(`${server.baseUrl}/2026/10/cost-report/`),
  ]);
  await server.flushArtifactViews();
}

async function capture(
  browser: Browser,
  server: RunningTestServer,
  theme: "dark" | "light",
): Promise<void> {
  // No stored choice, so the page follows the system setting.
  const context = await browser.newContext({colorScheme: theme});
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(page.locator("html")).toHaveClass(new RegExp(String.raw`\b${theme}\b`, "u"));
    await expect(page.getByRole("heading", {name: "Artifact Server"}))
      .toBeVisible();
    await expect(page.getByRole("link", {name: "Agent console"}))
      .toHaveAttribute("href", `${server.baseUrl}/2026/10/agent-console/`);
    await expect(page.getByRole("link", {name: "Incident summary"}))
      .toBeVisible();
    await expect(page.getByRole("heading", {name: "2026/10"})).toBeVisible();
    await expect(page.getByRole("heading", {name: "2026/11"})).toBeVisible();
    await expect(page.getByRole("heading", {name: "Without a path"}))
      .toBeVisible();
    // The page CSP blocks inline <style>; a bar whose colour never arrived
    // falls back to a black fill.
    const bar = page.locator("[data-slot=chart] .recharts-bar-rectangle path").first();
    expect(await fillOf(bar)).toBe((await toneColours(page, "--chart-views")).full);
    const violations = await new AxeBuilder({page}).analyze();
    expect(violations.violations).toEqual([]);
    await page.screenshot({
      fullPage: true,
      path: `test-results/browser/home-page-${theme}.png`,
    });
  } finally {
    await context.close();
  }
}
/** A reader's explicit choice beats the system setting and survives a reload. */
async function chooseTheme(browser: Browser, server: RunningTestServer): Promise<void> {
  const context = await browser.newContext({colorScheme: "dark"});
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
    await page.getByRole("button", {name: "Theme"}).click();
    await page.getByRole("menuitemradio", {name: "Light"}).click();
    await expect(page.locator("html")).toHaveClass(/\blight\b/u);
    await page.reload();
    await expect(page.getByRole("heading", {name: "Artifact Server"})).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/\blight\b/u);
    await page.getByRole("button", {name: "Theme"}).click();
    await expect(page.getByRole("menuitemradio", {name: "Light"}))
      .toHaveAttribute("aria-checked", "true");
  } finally {
    await context.close();
  }
}
