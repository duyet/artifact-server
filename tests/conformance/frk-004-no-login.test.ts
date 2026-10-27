import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

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
import {indexHtml, publishSite} from "../support/same-host-site.js";

const reviewShell = "<!doctype html><title>Review shell</title>";

async function redirectOf(
  url: string,
): Promise<{readonly location: string | null; readonly status: number}> {
  const response = await fetch(url, {redirect: "manual"});
  await response.arrayBuffer();
  return {location: response.headers.get("location"), status: response.status};
}

async function reviewFor(
  url: string,
  cookie: string,
): Promise<{readonly body: string; readonly location: string | null; readonly status: number}> {
  const response = await fetch(url, {headers: {Cookie: cookie}, redirect: "manual"});
  return {
    body: await response.text(),
    location: response.headers.get("location"),
    status: response.status,
  };
}

/** Sign a browser in with an API key, as the no-login sign-in form does. */
async function signIn(running: RunningTestServer, apiKey: string): Promise<string> {
  const response = await fetch(`${running.baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers: {
      "Content-Type": "application/json",
      Origin: running.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    method: "POST",
  });
  expect(response.status).toBe(204);
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .join("; ");
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

  /** Mint one member key as `admin issue-key` does, before the server starts. */
  async function issueMemberKey(): Promise<string> {
    const runtime = await createLocalRuntime({
      apiToken: installation.apiToken,
      bootstrapAdministratorEmail: "administrator@example.test",
      browserAccess: localOwnerBrowserAccess,
      contentDomain: null,
      dataDirectory: installation.dataDirectory,
    });
    try {
      const {issued} = await runtime.issueOperatorKey({
        displayName: "Ada Example",
        email: "ada@example.test",
        expiresAt: "2099-01-01T00:00:00.000Z",
        keyName: "Ada laptop",
        role: "member",
      });
      return issued.token;
    } finally {
      await runtime.close();
    }
  }

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await rm(webAssetsRoot, {force: true, recursive: true});
    await removeTestInstallation(installation);
  });

  test("FRK-004-B: login kind none is reported, the API key publishes, a Review link resolves to the artifact folder, and a signed-in member's Review link opens Review", async () => {
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
    const memberKey = await issueMemberKey();
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      webAssetsRoot,
    });

    const context = await fetch(`${server.baseUrl}/auth/context`);
    expect(await context.json()).toEqual({
      accessMode: "private_team",
      helpUrl: null,
      login: {kind: "none", oidc: false},
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

    const member = await signIn(server, memberKey);
    expect(await reviewFor(site.links.review, member)).toEqual({
      body: reviewShell,
      location: null,
      status: 200,
    });
  });

  test("FRK-004-F: browser login stays unavailable and a Review link cannot choose another route", async () => {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      webAssetsRoot,
    });

    const login = await fetch(`${server.baseUrl}/auth/login`, {redirect: "manual"});
    expect(login.status).toBe(404);
    expect(login.headers.get("location")).toBeNull();
    expect(login.headers.get("set-cookie")).toBeNull();

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

    // Only a live session opens Review; a forged session cookie still leaves.
    const forged = `artifact_session=${"f".repeat(43)}; artifact_csrf=${"c".repeat(43)}`;
    const artifactId = "art_3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(await reviewFor(`${server.baseUrl}/review?artifact=${artifactId}`, forged))
      .toMatchObject({location: `/artifacts/${artifactId}`, status: 302});
  });
});
