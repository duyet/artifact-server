import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const treeSchema = z.object({
  artifacts: z.array(z.object({name: z.string()})),
});

async function listedNames(server: RunningTestServer): Promise<string[]> {
  const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
  expect(response.status).toBe(200);
  return treeSchema.parse(await response.json()).artifacts.map(
    (artifact) => artifact.name,
  );
}

describe("public link discovery", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webRoot = await mkdtemp(path.join(tmpdir(), "artifact-auth-005-"));
    await writeFile(
      path.join(webRoot, "index.html"),
      '<!doctype html><title>Home</title><div id="home-root"></div>',
    );
    server = await startTestServer(installation, {
      contentDomain: null,
      webAssetsRoot: webRoot,
    });
  });

  afterEach(async () => {
    await server.stop();
    await rm(webRoot, {force: true, recursive: true});
    await removeTestInstallation(installation);
  });

  test("AUTH-005-B: a public link is served with noindex, nofollow and is listed on the anonymous tree", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });

    const content = await fetch(site.links.artifact);
    expect(content.status).toBe(200);
    expect(content.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await listedNames(server)).toEqual(["Agent console"]);
  });

  test("AUTH-005-F: an unlisted public link leaves the tree but stays served with noindex, and an account-required artifact is neither listed nor served anonymously", async () => {
    const publicSiteResult = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const privateSite = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });
    expect(await listedNames(server)).toEqual(["Agent console"]);

    const tagged = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${publicSiteResult.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: publicSiteResult.version.id,
          tags: ["unlisted"],
        }),
        headers: apiHeaders(installation, "auth-005-unlist-public-link"),
        method: "PATCH",
      },
    );
    expect(tagged.status).toBe(200);

    expect(await listedNames(server)).toEqual([]);
    const stillServed = await fetch(publicSiteResult.links.artifact);
    expect(stillServed.status).toBe(200);
    expect(stillServed.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const anonymous = await fetch(privateSite.links.artifact);
    expect(anonymous.status).not.toBe(200);
    expect(await anonymous.text()).not.toContain("Internal ledger");
  });
});
