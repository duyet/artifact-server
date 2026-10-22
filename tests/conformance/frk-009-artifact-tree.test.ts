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
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const viewCountsSchema = z.object({
  last7Days: z.number().int().nonnegative(),
  last30Days: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const publicTreeSchema = z.object({
  artifacts: z.array(z.object({
    access: z.literal("public_link"),
    name: z.string(),
    path: z.string().nullable(),
    series: z.array(z.object({
      count: z.number().int().nonnegative(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    })),
    updatedAt: z.iso.datetime(),
    url: z.url(),
    views: viewCountsSchema,
  })),
  generatedAt: z.iso.datetime(),
  loginKind: z.enum(["local_owner", "none"]),
  truncated: z.boolean(),
  windowDays: z.literal(30),
});
type PublicTree = z.infer<typeof publicTreeSchema>;

/** A clock a test moves by hand, so a day boundary is a fact and not a wait. */
function movableClock(start: Date) {
  return {
    instant: start,
    now() {
      return this.instant;
    },
  };
}

const today = new Date("2026-10-17T09:00:00.000Z");
const twoDaysAgo = new Date("2026-10-15T09:00:00.000Z");
const twentySevenDaysAgo = new Date("2026-09-20T09:00:00.000Z");

async function readTree(server: RunningTestServer): Promise<PublicTree> {
  const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
  expect(response.status).toBe(200);
  return publicTreeSchema.parse(await response.json());
}

function treeEntry(tree: PublicTree, name: string) {
  const entry = tree.artifacts.find((artifact) => artifact.name === name);
  if (entry === undefined) {
    throw new Error(`The public tree holds no artifact named ${name}.`);
  }
  return entry;
}

describe("public artifact tree", () => {
  let clock: ReturnType<typeof movableClock>;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = movableClock(today);
    // A stand-in for the compiled home page, so this test needs no web build.
    webRoot = await mkdtemp(path.join(tmpdir(), "artifact-home-"));
    await writeFile(
      path.join(webRoot, "index.html"),
      '<!doctype html><title>Home</title><div id="home-root"></div>',
    );
    await writeFile(
      path.join(webRoot, "review.html"),
      '<!doctype html><title>Review</title><div id="review-root"></div>',
    );
    server = await startTestServer(installation, {
      clock,
      contentDomain: null,
      webAssetsRoot: webRoot,
    });
  });

  afterEach(async () => {
    await server.stop();
    await rm(webRoot, {force: true, recursive: true});
    await removeTestInstallation(installation);
  });

  test("FRK-009-B: the tree lists public artifacts newest first, with sparse days and both windows", async () => {
    clock.instant = twentySevenDaysAgo;
    const october = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    clock.instant = twoDaysAgo;
    const november = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Cost report",
      path: "2026/11/cost-report",
    });
    clock.instant = today;
    const ungrouped = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Loose report",
    });

    const fresh = await readTree(server);
    expect(fresh.truncated).toBe(false);
    expect(fresh.windowDays).toBe(30);
    expect(fresh.loginKind).toBe("local_owner");
    expect(fresh.artifacts.map((artifact) => artifact.name)).toEqual([
      "Loose report",
      "Cost report",
      "Agent console",
    ]);
    expect(fresh.artifacts.map((artifact) => artifact.path)).toEqual([
      null,
      "2026/11/cost-report",
      "2026/10/agent-console",
    ]);
    // Each `url` is the link the publish response already named, built by the
    // one builder, so the tree cannot advertise an unservable address.
    expect(fresh.artifacts.map((artifact) => artifact.url)).toEqual([
      ungrouped.links.artifact,
      november.links.artifact,
      october.links.artifact,
    ]);
    for (const artifact of fresh.artifacts) {
      expect(artifact.access).toBe("public_link");
      expect(artifact.series).toEqual([]);
      expect(artifact.views).toEqual({
        last7Days: 0,
        last30Days: 0,
        total: 0,
      });
      expect(artifact.updatedAt.length).toBeGreaterThan(0);
    }

    // One view 27 days ago, one two days ago, and two today, so the 7-day,
    // 30-day, and all-time numbers each answer a different question.
    clock.instant = twentySevenDaysAgo;
    expect((await fetch(october.links.artifact)).status).toBe(200);
    clock.instant = twoDaysAgo;
    expect((await fetch(october.links.artifact)).status).toBe(200);
    clock.instant = today;
    expect((await fetch(october.links.artifact)).status).toBe(200);
    expect((await fetch(october.links.artifact)).status).toBe(200);
    await server.flushArtifactViews();

    const counted = treeEntry(await readTree(server), "Agent console");
    expect(counted.views).toEqual({
      last7Days: 3,
      last30Days: 4,
      total: 4,
    });
    // Sparse and ascending: three days, not thirty.
    expect(counted.series).toEqual([
      {count: 1, day: "2026-09-20"},
      {count: 1, day: "2026-10-15"},
      {count: 2, day: "2026-10-17"},
    ]);

    // The catalog caps at the 500 newest public artifacts and reports when a
    // read is capped: an exactly-full read already says `truncated`, because
    // a silent partial list would cost the reader an artifact they cannot
    // discover any other way.
    // Path claims race, so each artifact is claimed before the next one is
    // sent; parallel commits could fight over the same writer boundaries.
    for (let index = 1; index <= 496; index += 1) {
      clock.instant = new Date(today.getTime() + index * 60_000);
      // eslint-disable-next-line no-await-in-loop
      await publishBulkArtifact(server, installation, index);
    }
    const uncapped = await readTree(server);
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.artifacts.length).toBe(499);

    clock.instant = new Date(today.getTime() + 497 * 60_000);
    await publishBulkArtifact(server, installation, 497);
    const exactlyFull = await readTree(server);
    expect(exactlyFull.truncated).toBe(true);
    expect(exactlyFull.artifacts.length).toBe(500);

    clock.instant = new Date(today.getTime() + 498 * 60_000);
    await publishBulkArtifact(server, installation, 498);
    const capped = await readTree(server);
    expect(capped.truncated).toBe(true);
    // The window holds the newest 500: the last-published artifact leads it.
    expect(capped.artifacts.length).toBe(500);
    expect(capped.artifacts[0]?.path).toBe("2026/bulk/plant-0498");
    // The oldest artifact fell off the end of the window, and the flat list
    // stays newest first: every entry is at least as new as the next one.
    expect(capped.artifacts.map((artifact) => artifact.name))
      .not.toContain("Agent console");
    const stamps = capped.artifacts.map((artifact) => artifact.updatedAt);
    expect(stamps.toSorted().toReversed()).toEqual(stamps);
  }, 120_000);

  test("FRK-016-B FRK-016-F: the tree names the trusted origin behind a TLS-ending ingress, and keeps the request URL when nothing matches", async () => {
    await server.stop();
    server = await startTestServer(installation, {
      applicationOrigin: "https://example.test",
      clock,
      contentDomain: null,
      webAssetsRoot: webRoot,
    });
    await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });

    // The ingress ends TLS and the pod answers plain HTTP, so the request URL
    // is http and its host is the pod's. The tree still names the origin the
    // operator configured, matched against the forwarded host and protocol.
    const proxied = await fetch(`${server.baseUrl}/api/v1/public/tree`, {
      headers: {
        "X-Forwarded-Host": "example.test",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(proxied.status).toBe(200);
    const proxiedTree = publicTreeSchema.parse(await proxied.json());
    expect(proxiedTree.artifacts.length).toBe(1);
    for (const artifact of proxiedTree.artifacts) {
      expect(artifact.url.startsWith("https://example.test/")).toBe(true);
    }

    // Without forwarded headers that match the origin, the request URL stays
    // the authority, so a direct loopback read keeps its own address.
    const direct = await fetch(`${server.baseUrl}/api/v1/public/tree`);
    const directTree = publicTreeSchema.parse(await direct.json());
    for (const artifact of directTree.artifacts) {
      expect(artifact.url.startsWith(server.baseUrl)).toBe(true);
    }
  });

  test("FRK-009-F: a private or deleted artifact is absent, the endpoint needs no credential, and the application keeps its own", async () => {
    const publicSite = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });

    expect((await readTree(server)).artifacts.map((artifact) => artifact.name))
      .toEqual(["Agent console"]);

    // An old path left behind by a move stays public so its link still works,
    // and the unlisted tag keeps it out of the tree.
    const oldPath = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console (old address)",
      path: "old/agent-console",
    });
    expect((await readTree(server)).artifacts.map((artifact) => artifact.name).toSorted())
      .toEqual(["Agent console", "Agent console (old address)"]);
    const tagged = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${oldPath.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: oldPath.version.id,
          tags: ["Unlisted"],
        }),
        headers: apiHeaders(installation, "frk-009-unlist-old-path"),
        method: "PATCH",
      },
    );
    expect(tagged.status).toBe(200);
    expect((await readTree(server)).artifacts.map((artifact) => artifact.name))
      .toEqual(["Agent console"]);
    expect((await fetch(`${server.baseUrl}/old/agent-console/`)).status)
      .toBe(200);

    // `api` is a reserved path root, so no artifact can claim the endpoint's
    // prefix and shadow it with its own content.
    expect((await commitAtPath(
      server,
      installation,
      "api/v1/public/tree",
    )).status).toBe(422);

    const anonymous = await fetch(`${server.baseUrl}/api/v1/public/tree`);
    expect(anonymous.status).toBe(200);
    // Counts move between reads, so the browser revalidates instead of
    // reusing a cached copy of the catalog.
    expect(anonymous.headers.get("cache-control")).toBe("no-cache");
    // The catalog is application JSON, not artifact content, so it does not
    // carry the content sandbox.
    expect(anonymous.headers.get("content-security-policy") ?? "")
      .not.toContain("sandbox");
    // Only reads live under the anonymous prefix; a mutation there is no
    // route at all.
    expect((await fetch(`${server.baseUrl}/api/v1/public/tree`, {
      method: "POST",
    })).status).toBe(404);

    // `/` serves the application shell. It is application UI, so it carries
    // the application policy and never the content sandbox that protects
    // artifact bytes sharing this origin.
    const home = await fetch(`${server.baseUrl}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("home-root");
    const homePolicy = home.headers.get("content-security-policy") ?? "";
    expect(homePolicy).toContain("frame-ancestors 'none'");
    expect(homePolicy).not.toContain("sandbox");
    expect(home.headers.get("access-control-allow-origin")).toBeNull();
    // Review keeps its own URL; `/` no longer redirects to it.
    expect((await fetch(`${server.baseUrl}/review`)).status).toBe(200);

    // Deletion is a tombstone, and the tombstone leaves the public tree.
    const deleted = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${publicSite.artifact.id}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: publicSite.version.id,
        }),
        headers: apiHeaders(installation, "frk-009-delete-artifact"),
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(200);
    expect((await readTree(server)).artifacts).toEqual([]);

    // Everything an operator can reach still needs a credential.
    expect((await fetch(`${server.baseUrl}/api/v1/artifacts`)).status)
      .toBe(401);
    expect((await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    })).status).toBe(200);
  });
});

/**
 * Publish one single-file public artifact through the cheapest staged-upload
 * path, claiming one unique bulk path.
 */
async function publishBulkArtifact(
  server: RunningTestServer,
  installation: TestInstallation,
  index: number,
): Promise<void> {
  const bytes = new TextEncoder().encode(
    `<!doctype html><title>Bulk report ${index}</title>`,
  );
  const files = [{
    bytes,
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  }];
  const planned = await createStagedUpload(
    server,
    installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(installation, planned.body, files);
  const committed = await commitStagedUpload(
    installation,
    planned.body,
    `frk-009-bulk-${String(index).padStart(4, "0")}`,
    {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Bulk report",
      path: `2026/bulk/plant-${String(index).padStart(4, "0")}`,
    },
  );
  if (committed.response.status !== 201) {
    throw new Error(`The bulk commit returned HTTP ${committed.response.status}.`);
  }
}

/** Commit one new artifact at a path the application may refuse, and answer the status. */
async function commitAtPath(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactPath: string,
): Promise<Response> {
  const bytes = new TextEncoder().encode(
    "<!doctype html><title>Shadow attempt</title>",
  );
  const files = [{
    bytes,
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  }];
  const planned = await createStagedUpload(
    server,
    installation,
    "index.html",
    files,
  );
  await uploadEveryStagedFile(installation, planned.body, files);
  return fetch(planned.body.commitUrl, {
    body: JSON.stringify({
      target: {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: "Shadow attempt",
        path: artifactPath,
      },
    }),
    headers: apiHeaders(installation, `frk-009-shadow-${artifactPath.length}`),
    method: "POST",
  });
}