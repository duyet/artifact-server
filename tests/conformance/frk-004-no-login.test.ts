import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {InteractiveIdentityProvider} from "../../src/application/interactive-login.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {IdentityProviderFailure} from "../../src/core/errors.js";
import {loadOidcConfiguration} from "../../src/cli/oidc-configuration.js";
import {loadWorkOsConfiguration} from "../../src/cli/workos-configuration.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {indexHtml, publishSite} from "../support/same-host-site.js";

const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const reviewShell = "<!doctype html><title>Review shell</title>";

const unusedProvider: InteractiveIdentityProvider = {
  complete: () => Effect.fail(new IdentityProviderFailure({message: "unused"})),
  name: "unused-provider",
  start: () => Effect.fail(new IdentityProviderFailure({message: "unused"})),
};

async function redirectOf(
  url: string,
): Promise<{readonly location: string | null; readonly status: number}> {
  const response = await fetch(url, {redirect: "manual"});
  await response.arrayBuffer();
  return {location: response.headers.get("location"), status: response.status};
}

describe("a server with no browser login provider", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "frk-004-web-assets-"));
    await writeFile(path.join(webAssetsRoot, "review.html"), reviewShell);
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await rm(webAssetsRoot, {force: true, recursive: true});
    await removeTestInstallation(installation);
  });

  test("FRK-004-B: login kind none is reported, the API key publishes, and a Review link resolves to the artifact folder", async () => {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      webAssetsRoot,
    });

    const context = await fetch(`${server.baseUrl}/auth/context`);
    expect(await context.json()).toEqual({
      accessMode: "private_team",
      login: {kind: "none"},
    });

    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "No login site",
    });
    const stablePath = `/artifacts/${site.artifact.id}`;
    expect(await redirectOf(site.links.review)).toEqual({
      location: stablePath,
      status: 302,
    });
    expect(await redirectOf(`${server.baseUrl}${stablePath}`)).toEqual({
      location: site.links.artifact,
      status: 302,
    });
    const folder = await fetch(site.links.artifact);
    expect(folder.status).toBe(200);
    expect(await folder.text()).toBe(indexHtml);

    const shell = await fetch(`${server.baseUrl}/review`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe(reviewShell);
  });

  test("FRK-004-F: browser login stays unavailable, a Review link cannot choose another route, and a login kind that disagrees with its provider refuses to start", async () => {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      webAssetsRoot,
    });

    const login = await fetch(`${server.baseUrl}/auth/login`, {redirect: "manual"});
    expect(login.status).toBe(404);
    expect(errorBodySchema.parse(await login.json()).error.code)
      .toBe("INTERACTIVE_LOGIN_UNAVAILABLE");

    expect(await redirectOf(`${server.baseUrl}/review?artifact=..%2F..%2Fapi%2Fv1`))
      .toEqual({location: "/artifacts/..%2F..%2Fapi%2Fv1", status: 302});
    const shells = await Promise.all(
      ["artifact=", `artifact=${"a".repeat(201)}`].map(async (query) => {
        const shell = await fetch(`${server?.baseUrl}/review?${query}`, {
          redirect: "manual",
        });
        return {body: await shell.text(), status: shell.status};
      }),
    );
    expect(shells).toEqual([
      {body: reviewShell, status: 200},
      {body: reviewShell, status: 200},
    ]);
    await server.stop();
    server = undefined;

    await expect(startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    })).rejects.toThrow("requires exactly one OIDC or WorkOS");
    await expect(startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      interactiveIdentityProvider: unusedProvider,
    })).rejects.toThrow("cannot configure a browser-login provider");

    await expect(loadWorkOsConfiguration({
      ARTIFACT_SERVER_WORKOS_API_KEY: "partial-workos-secret",
    })).rejects.toThrow("Hosted WorkOS authentication requires");
    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "partial-oidc-client",
    })).rejects.toThrow("Generic OIDC authentication requires");

    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      contentDomain: null,
      interactiveIdentityProvider: unusedProvider,
      webAssetsRoot,
    });
    const withLogin = await fetch(
      `${server.baseUrl}/review?artifact=art_not-redirected`,
      {redirect: "manual"},
    );
    expect(withLogin.status).toBe(200);
    expect(await withLogin.text()).toBe(reviewShell);
  });
});
