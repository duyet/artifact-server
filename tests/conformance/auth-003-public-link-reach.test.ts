import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const treeSchema = z.object({
  artifacts: z.array(z.object({name: z.string(), path: z.string().nullable()})),
});
const artifactSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    currentVersionId: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
  }),
});

async function openAnonymously(
  urls: readonly string[],
): Promise<{status: number; url: string; served: boolean}[]> {
  return Promise.all(urls.map(async (url) => {
    const response = await fetch(url);
    return {
      served: (await response.text()).includes("Same-host site"),
      status: response.status,
      url,
    };
  }));
}

async function anonymousTree(
  server: RunningTestServer,
): Promise<z.infer<typeof treeSchema>["artifacts"]> {
  const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
  expect(response.status).toBe(200);
  return treeSchema.parse(await response.json()).artifacts;
}

describe("public links remove sign-in for anyone who can reach the server", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentDomain: null});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-003-B: a public artifact opens at its readable path and its version link without an account and is listed on the anonymous tree", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Release checklist",
      path: "2026/10/release-checklist",
    });
    expect(new URL(site.links.artifact).pathname).toBe("/2026/10/release-checklist/");

    const urls = [site.links.artifact, site.links.version];
    expect(await openAnonymously(urls))
      .toEqual(urls.map((url) => ({served: true, status: 200, url})));
    expect(await anonymousTree(server)).toEqual([
      {name: "Release checklist", path: "2026/10/release-checklist"},
    ]);
  });

  test("AUTH-003-F: a public link grants no anonymous mutation and exposes no account-required artifact beside it", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Release checklist",
      path: "2026/10/release-checklist",
    });
    const privateSite = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });
    const artifactUrl = `${server.baseUrl}/api/v1/artifacts/${site.artifact.id}`;
    const expected = {expectedCurrentVersionId: site.version.id};
    const mutations: readonly {method: string; url: string; body: unknown}[] = [
      {body: {...expected, accessSetting: "account_required"}, method: "PATCH", url: `${artifactUrl}/access`},
      {body: {...expected, tags: ["unlisted"]}, method: "PATCH", url: `${artifactUrl}/tags`},
      {body: {...expected, name: "Renamed"}, method: "PATCH", url: `${artifactUrl}/name`},
      {body: expected, method: "DELETE", url: artifactUrl},
      {body: {...expected, versionId: site.version.id}, method: "POST", url: `${artifactUrl}/restore`},
      {body: {entry: "index.html", files: []}, method: "POST", url: `${artifactUrl}/versions`},
    ];
    const refused = await Promise.all(mutations.map(async (mutation) => {
      const response = await fetch(mutation.url, {
        body: JSON.stringify(mutation.body),
        headers: {"Content-Type": "application/json", "Idempotency-Key": "auth-003-f-anonymous"},
        method: mutation.method,
      });
      return {status: response.status, target: `${mutation.method} ${mutation.url}`};
    }));
    expect(refused).toEqual(mutations.map((mutation) => ({
      status: 401,
      target: `${mutation.method} ${mutation.url}`,
    })));

    const unchanged = await fetch(artifactUrl, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(unchanged.status).toBe(200);
    expect(artifactSchema.parse(await unchanged.json()).artifact).toMatchObject({
      accessSetting: "public_link",
      currentVersionId: site.version.id,
      name: "Release checklist",
      tags: [],
    });

    const privateUrls = [privateSite.links.artifact, privateSite.links.version];
    expect(await openAnonymously(privateUrls))
      .toEqual(privateUrls.map((url) => ({served: false, status: 401, url})));
    expect((await anonymousTree(server)).map((item) => item.name))
      .toEqual(["Release checklist"]);
  });
});
