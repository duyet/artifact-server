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
  loginKind: z.enum(["local_owner", "none", "oidc", "workos"]),
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

    // `api` is a reserved path root, so no artifact can claim the endpoint's
    // prefix and shadow it with its own content.
    expect((await commitAtPath(
      server,
      installation,
      "api/v1/public/tree",
    )).status).toBe(422);

    const anonymous = await fetch(`${server.baseUrl}/api/v1/public/tree`);
    expect(anonymous.status).toBe(200);
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