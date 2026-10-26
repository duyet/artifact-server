import {expect, test} from "@playwright/test";
import {Redacted} from "effect";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {unknownOidcUserPolicies} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {startFakeOidcProvider} from "../support/fake-oidc-provider.js";
import {reserveLoopbackPort} from "../support/runtime-harness.js";
import {startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

const carol = {
  email: "carol@example.com",
  email_verified: true,
  name: "Carol Example",
  sub: "carol-subject",
};

test.describe("OIDC sign-in button", () => {
  test("Sign in with SSO goes to the provider and back into Review, a refusal shows on the gate, and the API-key form stays", async ({browser}) => {
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
      expect(fixture.server.baseUrl).toBe(`http://127.0.0.1:${port}`);
      const page = fixture.page;
      let answer: "approve" | "deny" = "deny";
      // The browser's leg of the flow: the provider redirects straight back.
      await page.route(`${provider.issuer}/**`, (route) => route.fulfill({
        headers: {
          location: answer === "approve"
            ? provider.approve(route.request().url(), carol)
            : provider.deny(route.request().url(), "access_denied"),
        },
        status: 302,
      }));

      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {name: "Sign in"})).toBeVisible();
      await expect(page.getByLabel("API key")).toBeVisible();
      await page.screenshot({path: "test-results/browser/screenshots/oidc-sign-in-gate.png"});

      await page.getByRole("link", {name: "Sign in with SSO"}).click();
      await expect(page.getByRole("alert")).toHaveText(
        "Single sign-on did not sign you in. Try again, or use an API key.",
      );
      await expect(page).toHaveURL(`${fixture.server.baseUrl}/review`);

      answer = "approve";
      await page.getByRole("link", {name: "Sign in with SSO"}).click();
      await expect(page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`^${fixture.server.baseUrl}/review`, "u"));
      const session = await fixture.context.request.get(`${fixture.server.baseUrl}/api/v1/session`);
      expect(session.status()).toBe(200);
      expect(await session.json()).toMatchObject({
        principal: {displayName: "Carol Example", membershipRole: "member"},
      });
    } finally {
      await stopBrowserFixture(fixture);
      await provider.stop();
    }
  });
});
