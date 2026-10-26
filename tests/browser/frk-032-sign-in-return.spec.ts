import {expect, test, type Page} from "@playwright/test";
import {Redacted} from "effect";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {defaultHelpUrl} from "../../src/core/help-link.js";
import {unknownOidcUserPolicies} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {type FakeOidcProvider, startFakeOidcProvider} from "../support/fake-oidc-provider.js";
import {reserveLoopbackPort} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";
import {startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

const carol = {
  email: "carol@example.com",
  email_verified: true,
  name: "Carol Example",
  sub: "carol-subject",
};
const readablePath = "team/plans";

/**
 * Playwright never routes the request a redirect leads to, so the start
 * response is answered here: the server's own pending cookie, and a provider
 * page that approves Carol and sends the browser straight to the callback.
 */
async function approveEverySignIn(page: Page, provider: FakeOidcProvider): Promise<void> {
  await page.route((url) => url.pathname === "/auth/oidc/start", async (route) => {
    // request.headers() leaves out Fetch Metadata, and the server reads Sec-Fetch-Site.
    const request = route.request();
    const started = await route.fetch({
      headers: {...request.headers(), "sec-fetch-site": await request.headerValue("sec-fetch-site") ?? ""},
      maxRedirects: 0,
    });
    const back = provider.approve(started.headers()["location"] ?? "", carol);
    await route.fulfill({
      body: `<!doctype html><meta http-equiv="refresh" content="0; url=${back.replaceAll("&", "&amp;")}">`,
      contentType: "text/html",
      headers: {"set-cookie": started.headers()["set-cookie"] ?? ""},
      status: 200,
    });
  });
}

function viewerBar(page: Page) {
  return page.getByRole("banner", {name: "Artifact viewer"});
}

test.describe("FRK-032 sign-in returns to the page it started from", () => {
  test("FRK-032-B: SSO from a readable page's bar comes back to that page signed in, with the account menu in the bar and in its actions menu on a phone, and Sign out keeps the page", async ({browser}) => {
    const provider = await startFakeOidcProvider();
    const port = await reserveLoopbackPort();
    const fixture = await startBrowserFixture(browser, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        provider: createOidcProvider({
          clientId: provider.clientId,
          clientSecret: Redacted.make(provider.clientSecret),
          fetch: provider.fetch,
          issuer: provider.issuer,
          redirectUri: `http://127.0.0.1:${port}/auth/oidc/callback`,
          scopes: "openid email profile",
        }),
        unknownUsers: unknownOidcUserPolicies.admit,
      }),
      colorScheme: "light",
      contentDomain: null,
      port,
    });
    try {
      const page = fixture.page;
      const published = await publishSite(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        name: "Team plans",
        path: readablePath,
      });
      const readableUrl = `${fixture.server.baseUrl}/${readablePath}/`;
      await approveEverySignIn(page, provider);

      await page.goto(readableUrl);
      const bar = viewerBar(page);
      const signIn = bar.getByRole("link", {name: "Sign in"});
      await expect(signIn).toHaveAttribute(
        "href",
        `/auth/oidc/start?returnArtifact=${published.artifact.id}`,
      );
      await signIn.click();

      await expect(page).toHaveURL(readableUrl);
      const avatar = bar.getByRole("button", {name: "Account: Carol Example"});
      await expect(avatar).toHaveText("CE");
      await expect(bar.getByRole("link", {name: "Sign in"})).toHaveCount(0);

      await avatar.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu.getByText("carol@example.com")).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText(["My artifacts", "Workbench", "Help", "Sign out"]);
      await expect(menu.getByRole("menuitem", {name: "Help"})).toHaveAttribute("href", defaultHelpUrl);
      await page.screenshot({path: "test-results/browser/screenshots/frk-032-bar-account-light.png"});
      await page.emulateMedia({colorScheme: "dark"});
      await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
      await page.screenshot({path: "test-results/browser/screenshots/frk-032-bar-account-dark.png"});
      await page.emulateMedia({colorScheme: "light"});
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(avatar).toBeFocused();

      await page.setViewportSize({height: 844, width: 390});
      await expect(avatar).toHaveCount(0);
      await bar.getByRole("button", {name: "Artifact actions"}).click();
      await expect(menu.getByText("carol@example.com")).toBeVisible();
      await expect(menu.getByRole("menuitem", {name: "My artifacts"})).toHaveAttribute("href", "/?mine=1");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.screenshot({path: "test-results/browser/screenshots/frk-032-bar-account-phone.png"});

      const cookieHeader = (await fixture.context.cookies(fixture.server.baseUrl))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      // Sign out loads the same page again, so wait for that load.
      await Promise.all([
        page.waitForEvent("load"),
        menu.getByRole("menuitem", {name: "Sign out"}).click(),
      ]);
      await expect(page).toHaveURL(readableUrl);
      await bar.getByRole("button", {name: "Artifact actions"}).click();
      await expect(menu.getByRole("menuitem", {name: "Sign in"})).toBeVisible();
      // The server revoked the session, so the old cookie no longer works.
      const stale = await fetch(`${fixture.server.baseUrl}/api/v1/session`, {headers: {Cookie: cookieHeader}});
      expect(stale.status).toBe(401);
    } finally {
      await stopBrowserFixture(fixture);
      await provider.stop();
    }
  });

  test("FRK-032-B: SSO from the home page header comes back to the home page signed in", async ({browser}) => {
    const provider = await startFakeOidcProvider();
    const port = await reserveLoopbackPort();
    const fixture = await startBrowserFixture(browser, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        provider: createOidcProvider({
          clientId: provider.clientId,
          clientSecret: Redacted.make(provider.clientSecret),
          fetch: provider.fetch,
          issuer: provider.issuer,
          redirectUri: `http://127.0.0.1:${port}/auth/oidc/callback`,
          scopes: "openid email profile",
        }),
        unknownUsers: unknownOidcUserPolicies.admit,
      }),
      contentDomain: null,
      port,
    });
    try {
      const page = fixture.page;
      await approveEverySignIn(page, provider);
      await page.goto(fixture.server.baseUrl);
      const primary = page.getByRole("navigation", {name: "Primary"});
      await expect(primary.getByRole("link", {name: "Sign in"}))
        .toHaveAttribute("href", "/auth/oidc/start?returnTo=%2F");
      await primary.getByRole("link", {name: "Sign in"}).click();
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/`);
      await expect(primary.getByRole("button", {name: "Account: Carol Example"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
      await provider.stop();
    }
  });
});
