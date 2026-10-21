import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Browser} from "@playwright/test";

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
});

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
    const colours = await page.evaluate(() => {
      const bar = document.querySelector("[data-slot=chart] .recharts-bar-rectangle path");
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return {bar: bar === null ? null : getComputedStyle(bar).fill, expected};
    });
    expect(colours.bar).toBe(colours.expected);
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
