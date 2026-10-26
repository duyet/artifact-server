import {expect, test} from "@playwright/test";

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
  type TestInstallation,
} from "../support/runtime-harness.js";

const bootstrapAdministratorEmail = "administrator@example.test";
const helpUrl = "https://help.example.com/artifact-server";

test.describe("home page account menu", () => {
  test("FRK-031-B FRK-031-F: Sign in when signed out, a keyboard account menu when signed in, and Sign out revokes the session", async ({browser}) => {
    const installation = await createTestInstallation();
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
    const alice = await issueMemberKey(installation, "Alice Example", "alice@example.com");
    const server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      helpUrl,
    });
    const anonymous = await browser.newContext();
    const member = await browser.newContext();
    try {
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto(server.baseUrl);
      const primary = anonymousPage.getByRole("navigation", {name: "Primary"});
      await expect(primary.getByRole("link", {name: "Sign in"})).toHaveAttribute("href", "/review");
      await expect(primary.getByRole("button", {name: /^Account:/u})).toHaveCount(0);

      const signedIn = await member.request.post(`${server.baseUrl}/auth/api-key`, {
        data: {apiKey: alice},
        headers: {
          Origin: server.baseUrl,
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      expect(signedIn.status()).toBe(204);
      const page = await member.newPage();
      await page.goto(server.baseUrl);
      const avatar = page.getByRole("button", {name: "Account: Alice Example"});
      await expect(avatar).toHaveText("AE");
      await expect(page.getByRole("link", {name: "Sign in"})).toHaveCount(0);

      await avatar.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByText("alice@example.com")).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText(["My artifacts", "Workbench", "Help", "Sign out"]);
      await expect(menu.getByRole("menuitem", {name: "My artifacts"})).toHaveAttribute("href", "/?mine=1");
      await expect(menu.getByRole("menuitem", {name: "Workbench"})).toHaveAttribute("href", "/review");
      await expect(menu.getByRole("menuitem", {name: "Help"})).toHaveAttribute("href", helpUrl);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(avatar).toBeFocused();

      const cookieHeader = (await member.cookies(server.baseUrl))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      await avatar.click();
      await page.getByRole("menuitem", {name: "Sign out"}).click();
      await expect(page.getByRole("link", {name: "Sign in"})).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      // The server revoked the session, so the old cookie no longer works.
      const stale = await fetch(`${server.baseUrl}/api/v1/session`, {headers: {Cookie: cookieHeader}});
      expect(stale.status).toBe(401);
    } finally {
      await anonymous.close();
      await member.close();
      await server.stop();
      await removeTestInstallation(installation);
    }
  });
});

/** Mint one member and a key in their name, as `admin issue-key` does. */
async function issueMemberKey(
  installation: TestInstallation,
  displayName: string,
  email: string,
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
      keyName: `${displayName} laptop`,
      role: "member",
    })).issued.token;
  } finally {
    await runtime.close();
  }
}
