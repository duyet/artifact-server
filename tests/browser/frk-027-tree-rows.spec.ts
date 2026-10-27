import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Browser, type BrowserContext, type Page} from "@playwright/test";

import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const bootstrapAdministratorEmail = "administrator@example.test";

/**
 * The home tree's rows as an anonymous reader and as a signed-in member see
 * them. Alice and Bob are members; each publishes with a key in their name.
 */
test.describe("artifact tree rows", () => {
  test("FRK-027-B FRK-027-F: sparkline tooltip, sort, Mine, and a visibility change from the row menu, with no menu for an anonymous reader", async ({browser}) => {
    const installation = await createTestInstallation();
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
    const alice = await issueMemberKey(installation, "Alice Example", "alice@example.com", "Alice Example @ laptop");
    const bob = await issueMemberKey(installation, "Bob Example", "bob@example.com", "Bob Example");
    const server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    });
    try {
      // Published one after another, so newest first is Bob's plan, then
      // Alice's notes, then her report.
      const asAlice = {...installation, apiToken: alice};
      await publishSite(server, asAlice, {accessSetting: "public_link", name: "Alice report", path: "team/alice-report"});
      await publishSite(server, asAlice, {accessSetting: "public_link", name: "Alice notes", path: "team/alice-notes"});
      await publishSite(server, {...installation, apiToken: bob}, {
        accessSetting: "public_link",
        name: "Bob plan",
        path: "team/bob-plan",
      });
      await Promise.all([
        fetch(`${server.baseUrl}/team/alice-report/`),
        fetch(`${server.baseUrl}/team/alice-report/`),
        fetch(`${server.baseUrl}/team/alice-report/`),
        fetch(`${server.baseUrl}/team/bob-plan/`),
      ]);
      await server.flushArtifactViews();

      await expectAnonymousRows(browser, server);
      await expectMemberRows(browser, server, alice);
      await captureMemberMenu(browser, server, alice, "dark");
      // Alice made her report private from its row menu, so an anonymous
      // reader no longer finds it.
      const anonymous = await browser.newContext();
      try {
        const page = await anonymous.newPage();
        await page.goto(server.baseUrl);
        await expect(rowLinks(page)).toHaveText(["Bob plan", "Alice notes"]);
      } finally {
        await anonymous.close();
      }
    } finally {
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});

/** An anonymous reader sees owners and sparklines but no menu and no Mine. */
async function expectAnonymousRows(browser: Browser, server: RunningTestServer): Promise<void> {
  const context = await browser.newContext({colorScheme: "light"});
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(rowLinks(page)).toHaveText(["Bob plan", "Alice notes", "Alice report"]);
    await expect(page.locator("[data-slot=tree-row]").filter({hasText: "Alice report"}))
      .toContainText("Alice Example @ laptop");
    await expect(page.getByRole("button", {name: /^Actions for /u})).toHaveCount(0);
    await expect(page.getByRole("button", {name: "Mine"})).toHaveCount(0);
    await expect(page.getByText("3 public artifacts")).toBeVisible();
  } finally {
    await context.close();
  }
}

async function expectMemberRows(
  browser: Browser,
  server: RunningTestServer,
  apiKey: string,
): Promise<void> {
  const context = await signedInContext(browser, server, apiKey, "light");
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(page.getByText("3 artifacts")).toBeVisible();
    // The row menus load after the page; wait for them so no row moves
    // under the pointer.
    await expect(page.getByRole("button", {name: /^Actions for /u})).toHaveCount(2);

    // The row's numbers live in its sparkline's name and tooltip.
    const summary = "3 views in 7 days, 3 in 30 days, 3 in all";
    const sparkline = page.getByRole("img", {name: `Alice report: ${summary}`});
    await sparkline.hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(summary);

    // Sort applies inside the folder, and the browser remembers it.
    await expect(rowLinks(page)).toHaveText(["Bob plan", "Alice notes", "Alice report"]);
    const sort = page.getByRole("combobox", {name: "Sort artifacts"});
    await sort.selectOption("views");
    await expect(rowLinks(page)).toHaveText(["Alice report", "Bob plan", "Alice notes"]);
    await sort.selectOption("name");
    await expect(rowLinks(page)).toHaveText(["Alice notes", "Alice report", "Bob plan"]);
    await page.reload();
    await expect(page.getByRole("combobox", {name: "Sort artifacts"})).toHaveValue("name");
    await expect(rowLinks(page)).toHaveText(["Alice notes", "Alice report", "Bob plan"]);

    // Mine keeps only Alice's own artifacts, and the account menu's link
    // opens the page that way.
    await page.getByRole("button", {name: "Mine"}).click();
    await expect(rowLinks(page)).toHaveText(["Alice notes", "Alice report"]);
    await page.goto(`${server.baseUrl}/?mine=1`);
    await expect(page.getByRole("button", {name: "Mine"})).toHaveAttribute("aria-pressed", "true");
    await expect(rowLinks(page)).toHaveText(["Alice notes", "Alice report"]);
    await page.getByRole("button", {name: "Mine"}).click();

    // Alice may change only what she owns, so Bob's plan has no menu.
    await expect(page.getByRole("button", {name: /^Actions for /u})).toHaveCount(2);
    await expect(page.getByRole("button", {name: "Actions for Bob plan"})).toHaveCount(0);
    const violations = await new AxeBuilder({page}).analyze();
    expect(violations.violations).toEqual([]);

    await page.getByRole("button", {name: "Actions for Alice report"}).click();
    await expect(page.getByRole("menuitemradio", {name: "Public"})).toHaveAttribute("aria-checked", "true");
    await page.screenshot({fullPage: true, path: "test-results/browser/home-tree-menu-light.png"});
    // The change lands but the tree's reread fails. The page keeps the rows it
    // has and says the refresh failed, and the next read catches up.
    await page.route(isCatalogRead, (route) =>
      route.fulfill({json: {error: {message: "Catalog read failed."}}, status: 503}));
    await page.getByRole("menuitemradio", {name: "Private"}).click();
    await expect(page.getByText("Alice report is now private.")).toBeVisible();
    await expect(page.getByText("The catalog could not be refreshed.")).toBeVisible();
    await expect(page.getByRole("heading", {name: "Catalog unavailable"})).toHaveCount(0);
    await expect(rowLinks(page)).toHaveText(["Alice notes", "Alice report", "Bob plan"]);
    await page.unroute(isCatalogRead);
    await page.reload();
    await expect(page.getByRole("button", {name: /^Actions for /u})).toHaveCount(2);
    const reportRow = page.locator("[data-slot=tree-row]").filter({hasText: "Alice report"});
    await expect(reportRow).toContainText("Private");
    await page.screenshot({fullPage: true, path: "test-results/browser/home-tree-member-light.png"});

    // Giving a private artifact a link again asks first, and Cancel keeps it
    // private. The toast sits over the last rows until it times out, and a
    // pointer resting on it would hold it open.
    await page.mouse.move(0, 0);
    await expect(page.getByText("Alice report is now private.")).toHaveCount(0);
    await page.getByRole("button", {name: "Actions for Alice report"}).click();
    await page.getByRole("menuitemradio", {name: "Public"}).click();
    const confirm = page.getByRole("alertdialog", {name: "Share Alice report by link?"});
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", {name: "Cancel"}).click();
    await expect(confirm).toHaveCount(0);
    await expect(reportRow).toContainText("Private");
  } finally {
    await context.close();
  }
}

async function captureMemberMenu(
  browser: Browser,
  server: RunningTestServer,
  apiKey: string,
  theme: "dark" | "light",
): Promise<void> {
  const context = await signedInContext(browser, server, apiKey, theme);
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await expect(page.locator("html")).toHaveClass(new RegExp(String.raw`\b${theme}\b`, "u"));
    await expect(page.getByRole("button", {name: /^Actions for /u})).toHaveCount(2);
    await page.getByRole("img", {name: /^Bob plan: /u}).hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toBeVisible();
    await page.screenshot({fullPage: true, path: `test-results/browser/home-tree-member-${theme}.png`});
    await page.getByRole("button", {name: "Actions for Alice notes"}).click();
    await expect(page.getByRole("menuitemradio", {name: "Unlisted"})).toBeVisible();
    await page.screenshot({fullPage: true, path: `test-results/browser/home-tree-menu-${theme}.png`});
  } finally {
    await context.close();
  }
}

/** A browser context holding a member's session, signed in with their key. */
async function signedInContext(
  browser: Browser,
  server: RunningTestServer,
  apiKey: string,
  theme: "dark" | "light",
): Promise<BrowserContext> {
  const context = await browser.newContext({colorScheme: theme});
  const response = await context.request.post(`${server.baseUrl}/auth/api-key`, {
    data: {apiKey},
    headers: {
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  expect(response.status()).toBe(204);
  return context;
}

/** Mint one member and a key in their name, as `admin issue-key` does. */
async function issueMemberKey(
  installation: TestInstallation,
  displayName: string,
  email: string,
  keyName: string,
): Promise<string> {
  const runtime = await createLocalRuntime({
    apiToken: installation.apiToken,
    bootstrapAdministratorEmail,
    browserAccess: localOwnerBrowserAccess,
    contentDomain: null,
    dataDirectory: installation.dataDirectory,
  });
  try {
    return (await runtime.issueOperatorKey({
      displayName,
      email,
      expiresAt: "2099-01-01T00:00:00.000Z",
      keyName,
      role: "member",
    })).issued.token;
  } finally {
    await runtime.close();
  }
}

/** The home page's read of the public tree. */
function isCatalogRead(url: URL): boolean {
  return url.pathname === "/api/v1/public/tree";
}

/** The artifact links of the tree's rows, in page order. */
function rowLinks(page: Page) {
  return page.locator("[data-slot=tree-row]").getByRole("link");
}
