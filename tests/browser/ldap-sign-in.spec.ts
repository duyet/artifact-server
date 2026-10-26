import {expect, test} from "@playwright/test";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {unknownDirectoryUserPolicies} from "../../src/core/directory-sign-in.js";
import {createLdapDirectoryAuthenticator} from
  "../../src/directory/ldap-directory-authenticator.js";
import {startFakeLdapDirectory} from "../support/fake-ldap-directory.js";
import {startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

const people = "ou=people,dc=example,dc=com";

test.describe("LDAP sign-in form", () => {
  test("a directory user signs in from the Review gate, and the API-key form stays beside it", async ({browser}) => {
    const directory = await startFakeLdapDirectory({
      entries: {
        [`uid=carol,${people}`]: {
          attributes: {displayName: ["Carol Example"], mail: ["carol@example.com"]},
          password: "carol password",
        },
      },
    });
    const fixture = await startBrowserFixture(browser, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        authenticator: createLdapDirectoryAuthenticator({
          caCertificates: null,
          displayNameAttribute: "displayName",
          emailAttribute: "mail",
          requiredGroupDn: null,
          timeoutMilliseconds: 2_000,
          url: directory.url,
          userDnTemplate: `uid={username},${people}`,
        }),
        unknownUsers: unknownDirectoryUserPolicies.admit,
      }),
      contentDomain: null,
    });
    try {
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review`);
      await expect(page.getByRole("heading", {name: "Sign in"})).toBeVisible();
      await expect(page.getByLabel("API key")).toBeVisible();
      await page.screenshot({path: "test-results/browser/screenshots/ldap-sign-in-gate.png"});

      await page.getByLabel("Username").fill("carol");
      await page.getByLabel("Password").fill("wrong password");
      await page.getByRole("button", {name: "Sign in"}).first().click();
      await expect(page.getByRole("alert")).toHaveText("That username or password was not accepted.");
      await expect(page.getByLabel("Password")).toHaveValue("");

      await page.getByLabel("Password").fill("carol password");
      await page.getByRole("button", {name: "Sign in"}).first().click();
      await expect(page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
      const session = await fixture.context.request.get(`${fixture.server.baseUrl}/api/v1/session`);
      expect(session.status()).toBe(200);
      expect(await session.json()).toMatchObject({
        principal: {displayName: "Carol Example", membershipRole: "member"},
      });
    } finally {
      await stopBrowserFixture(fixture);
      await directory.stop();
    }
  });
});
