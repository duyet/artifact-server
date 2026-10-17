import {DatabaseSync} from "node:sqlite";
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

const viewCountsSchema = z.object({
  last7Days: z.number().int().nonnegative(),
  last30Days: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const publicTreeSchema = z.object({
  artifacts: z.array(z.object({
    name: z.string(),
    path: z.string().nullable(),
    series: z.array(z.object({
      count: z.number().int().nonnegative(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    })),
    url: z.url(),
    views: viewCountsSchema,
  })),
  generatedAt: z.string(),
  loginKind: z.string(),
  truncated: z.boolean(),
  windowDays: z.number().int().positive(),
});
type PublicTree = z.infer<typeof publicTreeSchema>;

/** A pinned clock, so a counted view lands on a day the assertion can name. */
function fixedClock(instant: Date) {
  return {now: () => instant};
}

const today = "2026-10-17";
const todayInstant = new Date(`${today}T09:00:00.000Z`);

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

/** The stored rows for one artifact, read straight from the test database. */
function storedViewRows(
  installation: TestInstallation,
  artifactId: string,
): readonly {count: number; day: string}[] {
  return withDatabase(installation, (database) =>
    z.array(z.object({count: z.number(), day: z.string()}))
      .parse(database.prepare(
        `SELECT count, day FROM artifact_views WHERE artifact_id = ? ORDER BY day`,
      ).all(artifactId)));
}

function storedViewColumns(installation: TestInstallation): readonly string[] {
  return withDatabase(installation, (database) =>
    z.array(z.object({name: z.string()}))
      .parse(database.prepare("PRAGMA table_info(artifact_views)").all())
      .map((column) => column.name));
}

function withDatabase<Result>(
  installation: TestInstallation,
  read: (database: DatabaseSync) => Result,
): Result {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {allowExtension: false, readOnly: true},
  );
  try {
    return read(database);
  } finally {
    database.close();
  }
}

describe("entry-document view counts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      clock: fixedClock(todayInstant),
      contentDomain: null,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("FRK-008-B: the entry document counts at its path, its folder, and its version URL", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const artifactId = site.artifact.id;
    const pathUrl = `${server.baseUrl}/2026/10/agent-console/`;
    // The folder URL is `<name-slug>-<uuid>` with the `art_` prefix removed.
    const folderUrl = `${server.baseUrl}/agent-console-` +
      `${artifactId.slice("art_".length)}/`;

    // Two navigations to the entry document at its readable path.
    expect((await fetch(pathUrl)).status).toBe(200);
    expect((await fetch(pathUrl)).status).toBe(200);

    // A buffered count is invisible to a read until the drain runs. That is
    // the observable form of "the content response never waits for a write".
    expect(treeEntry(await readTree(server), "Agent console").views.total)
      .toBe(0);

    await server.flushArtifactViews();
    const drained = treeEntry(await readTree(server), "Agent console");
    expect(drained.views).toEqual({
      last7Days: 2,
      last30Days: 2,
      total: 2,
    });
    expect(drained.series).toEqual([{count: 2, day: today}]);
    expect(storedViewRows(installation, artifactId)).toEqual([
      {count: 2, day: today},
    ]);

    // The folder URL and the version URL reach the same document, so each
    // adds one more view without a second call site.
    expect((await fetch(folderUrl)).status).toBe(200);
    expect((await fetch(`${site.links.version}index.html`)).status).toBe(200);
    await server.flushArtifactViews();
    const afterEveryForm = treeEntry(await readTree(server), "Agent console");
    expect(afterEveryForm.views.total).toBe(4);
    expect(storedViewRows(installation, artifactId)).toEqual([
      {count: 4, day: today},
    ]);
  });

  test("FRK-008-F: assets, probes, misses, leases, and private artifacts add nothing, and the table names no viewer", async () => {
    const publicSite = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const privateSite = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });
    const pathUrl = `${server.baseUrl}/2026/10/agent-console/`;

    // A stylesheet and a nested page are assets, not the entry document.
    expect((await fetch(`${pathUrl}assets/a.css`)).status).toBe(200);
    expect((await fetch(`${pathUrl}docs/nested/page.html`)).status).toBe(200);
    // A HEAD probe and a bare path that only redirects never carry a document.
    expect((await fetch(pathUrl, {method: "HEAD"})).status).toBe(200);
    const withoutSlash = await fetch(
      `${server.baseUrl}/2026/10/agent-console`,
      {redirect: "manual"},
    );
    expect(withoutSlash.status).toBe(308);
    // An unknown path serves nothing at all.
    expect((await fetch(`${server.baseUrl}/2026/10/absent/`)).status).toBe(404);
    // A lease renders an artifact's version inside another surface, so it is
    // never a view of that artifact's own page.
    const lease = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${publicSite.artifact.id}/versions/` +
        `${publicSite.version.id}/preview-leases`,
      {headers: apiHeaders(installation, "frk-008-issue-lease"), method: "POST"},
    );
    expect(lease.status).toBe(201);
    const leaseUrl = z.object({baseUrl: z.url()})
      .parse(await lease.json()).baseUrl;
    expect((await fetch(leaseUrl)).status).toBe(200);
    // A private artifact cannot be opened at all, so it cannot be counted.
    expect((await fetch(`${server.baseUrl}/2026/10/internal-ledger/`)).status)
      .toBe(401);

    await server.flushArtifactViews();
    expect(storedViewRows(installation, publicSite.artifact.id)).toEqual([]);
    expect(storedViewRows(installation, privateSite.artifact.id)).toEqual([]);
    expect((await readTree(server)).artifacts.map((a) => a.name))
      .toEqual(["Agent console"]);

    // The whole counter is three columns, so there is nowhere for an address,
    // a session, a referrer, or a user agent to be stored.
    expect(storedViewColumns(installation)).toEqual([
      "artifact_id",
      "day",
      "count",
    ]);
    // A counted page gains no cookie and is handed no counting token, so the
    // counter cannot follow the reader to a second deployment.
    const entry = await fetch(pathUrl);
    expect(entry.headers.getSetCookie()).toEqual([]);
    expect(entry.headers.get("x-artifact-view-token")).toBeNull();
  });
});