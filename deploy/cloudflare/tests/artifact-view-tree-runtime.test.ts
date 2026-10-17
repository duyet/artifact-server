import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-view-tree-test-api-token-0000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const publicArtifactName = "Homepage public page";
const expectedEntryBody = "<h1>Homepage public page</h1>";
const drainDeadlineMilliseconds = 10_000;
const drainIntervalMilliseconds = 100;

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).length(1),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
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
    updatedAt: z.string(),
    url: z.url(),
    views: z.object({
      last7Days: z.number().int().nonnegative(),
      last30Days: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  })),
  generatedAt: z.string(),
  loginKind: z.string(),
  truncated: z.boolean(),
  windowDays: z.number().int().positive(),
});
type PublicTreeEntry = z.infer<typeof publicTreeSchema>["artifacts"][number];
const viewColumnRowSchema = z.object({name: z.string()});
const viewRowSchema = z.object({
  artifactId: z.string(),
  count: z.coerce.number().int().nonnegative(),
  day: z.string(),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-views-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 entry views and the public tree", () => {
  it("counts the served entry document in D1 and shows the windows in the public tree", async () => {
    const published = await publishPublicArtifact(
      worker,
      "cloudflare-view-tree-publish-1",
    );
    const artifactId = published.artifact.id;
    const expectedDay = new Date().toISOString().slice(0, 10);

    // The counter is buffered behind the content response, so nothing has
    // reached D1 before the first entry navigation.
    const unread = await treeEntry(worker, artifactId);
    expect(unread.views).toEqual({last7Days: 0, last30Days: 0, total: 0});

    const entry = await worker.fetch(published.links.version);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(expectedEntryBody);

    // A worker has no drain seam a test can await: `unstable_dev` hides the
    // `waitUntil` promises the flush is scheduled on. Every request schedules
    // a flush, so the tree read is retried until D1 accepts the buffered
    // count, the way a polling browser eventually sees it.
    const drained = await awaitedTreeEntry(worker, artifactId, 1);
    expect(drained.views).toEqual({last7Days: 1, last30Days: 1, total: 1});
    expect(drained.series).toEqual([{count: 1, day: expectedDay}]);
    expect(drained.url).toContain(`/artifacts/${artifactId}`);

    // A HEAD probe, a missing asset, and the home shell never carry an entry
    // document, so none of them may count or write a row.
    const probed = await worker.fetch(published.links.version, {method: "HEAD"});
    expect(probed.status).toBe(200);
    const missing = await worker.fetch(`${published.links.version}missing.html`);
    expect(missing.status).toBe(404);
    const home = await worker.fetch(`${origin}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).not.toBe(expectedEntryBody);

    const afterMisses = await awaitedTreeEntry(worker, artifactId, 1);
    expect(afterMisses.views).toEqual({last7Days: 1, last30Days: 1, total: 1});

    // The count has to survive a Worker restart out of its D1 rows, so the
    // restarted Worker shows it without a flush having anything left to do.
    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = await awaitedTreeEntry(worker, artifactId, 1);
    expect(afterRestart.views).toEqual({last7Days: 1, last30Days: 1, total: 1});

    const database = new DatabaseSync(
      await findD1DatabaseFile(persistPath),
      {readOnly: true},
    );
    try {
      // The whole counter is three columns, so there is nowhere for an
      // address, a session, a referrer, or a user agent to be stored.
      const columns = z.array(viewColumnRowSchema)
        .parse(database.prepare("PRAGMA table_info(artifact_views)").all())
        .map(({name}) => name);
      expect(columns).toEqual(["artifact_id", "day", "count"]);
      const rows = z.array(viewRowSchema).parse(database.prepare(`
        SELECT artifact_id AS artifactId, day, count FROM artifact_views
        ORDER BY artifact_id, day
      `).all());
      expect(rows).toEqual([{artifactId, count: 1, day: expectedDay}]);
    } finally {
      database.close();
    }
  }, 60_000);
});

function awaitedTreeEntry(
  target: Unstable_DevWorker,
  artifactId: string,
  expectedTotal: number,
): Promise<PublicTreeEntry> {
  const deadline = Date.now() + drainDeadlineMilliseconds;
  const read = (remainingMilliseconds: number): Promise<PublicTreeEntry> =>
    treeEntry(target, artifactId).then((entry) =>
      entry.views.total === expectedTotal
        ? entry
        : remainingMilliseconds <= 0
        ? Promise.reject(new Error(
            `The public tree held a total of ${entry.views.total} views for ` +
              `${artifactId} instead of ${expectedTotal}`,
          ))
        : new Promise((resolve) => setTimeout(
            resolve,
            drainIntervalMilliseconds,
          )).then(() => read(
            remainingMilliseconds - drainIntervalMilliseconds
          )),
    );
  return read(deadline);
}

async function treeEntry(
  target: Unstable_DevWorker,
  artifactId: string,
): Promise<PublicTreeEntry> {
  const response = await target.fetch(`${origin}/api/v1/public/tree`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const tree = publicTreeSchema.parse(await response.json());
  const entry = tree.artifacts.find((candidate) =>
    candidate.url.endsWith(`/artifacts/${artifactId}`)
  );
  if (entry === undefined) {
    throw new Error(`The public tree holds no artifact with ID ${artifactId}.`);
  }
  return entry;
}

async function publishPublicArtifact(
  target: Unstable_DevWorker,
  idempotencyKey: string,
) {
  const bytes = new TextEncoder().encode(expectedEntryBody);
  const createUpload = await target.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: jsonHeaders(),
    method: "POST",
  });
  expect(createUpload.status).toBe(201);
  const uploadPlan = uploadPlanSchema.parse(await createUpload.json());
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await target.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: {Authorization: `Bearer ${apiToken}`},
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  const committed = await target.fetch(uploadPlan.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: publicArtifactName,
      tags: ["homepage"],
    }}),
    headers: {
      ...jsonHeaders(),
      "Idempotency-Key": idempotencyKey,
    },
    method: "POST",
  });
  const committedBody = await committed.text();
  if (committed.status !== 201) {
    throw new Error(
      `Publishing the public artifact failed with ${committed.status}: ${committedBody}`,
    );
  }
  return publicationSchema.parse(JSON.parse(committedBody));
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries
    .filter((entry) =>
      entry.isFile() && entry.name.endsWith(".sqlite") &&
      entry.parentPath.includes("D1")
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .find((candidate) => {
      const database = new DatabaseSync(candidate, {readOnly: true});
      try {
        return database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'artifact_views'
        `).get() !== undefined;
      } finally {
        database.close();
      }
    });
  if (found === undefined) {
    throw new Error("The Worker did not persist a local D1 database file.");
  }
  return found;
}

function jsonHeaders() {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL:
        "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-view-tree-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-view-tree-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
