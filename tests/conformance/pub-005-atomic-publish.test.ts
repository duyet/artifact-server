import {createHash} from "node:crypto";
import {readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  parsePublishResponse,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

/** Every table a publish writes, read whole so any surviving row shows. */
const publicationTables = [
  "artifacts",
  "artifact_tags",
  "versions",
  "manifest_entries",
  "actions",
  "idempotency_records",
  "staged_uploads",
] as const;

type Snapshot = Record<string, unknown[]>;

type CommitTarget =
  | {
    readonly accessSetting: "account_required";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly path: string;
    readonly tags: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

interface Refusal {
  readonly event: string;
  readonly label: string;
}

const newArtifactRefusals: readonly Refusal[] = [
  {event: "BEFORE INSERT ON artifacts", label: "artifact row"},
  {event: "BEFORE INSERT ON artifact_tags", label: "tags"},
  {event: "BEFORE INSERT ON versions", label: "version row"},
  {event: "BEFORE INSERT ON manifest_entries", label: "manifest entries"},
  {event: "BEFORE UPDATE OF current_version_id ON artifacts", label: "current pointer"},
  {event: "BEFORE INSERT ON actions", label: "action record"},
  {event: "BEFORE INSERT ON idempotency_records", label: "idempotency result"},
  {event: "BEFORE UPDATE ON staged_uploads", label: "upload seal"},
];

const newVersionRefusals: readonly Refusal[] = newArtifactRefusals.filter(
  ({event}) => !event.includes("INSERT ON artifacts") && !event.includes("artifact_tags"),
);

const manifestEntrySchema = z.object({sha256: z.string(), size: z.number()});

describe("atomic publication and its blob-before-record order", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    // Readable paths need a deployment without a content domain.
    server = await startTestServer(installation, {contentDomain: null});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PUB-005-B PUB-005-F: a publish writes every record together, and a refusal at any write leaves none of them", async () => {
    const before = snapshot();
    const created = await publish(
      "<h1>atomic base</h1>",
      newArtifact("atomic/base"),
      "atomic-base-create",
    );
    expect(created.status).toBe(201);
    const base = await publishBody(created);
    const afterCreate = snapshot();
    expect(Object.fromEntries(publicationTables.map((table) => [
      table,
      (afterCreate[table]?.length ?? 0) - (before[table]?.length ?? 0),
    ]))).toEqual(Object.fromEntries(publicationTables.map((table) => [table, 1])));
    expect(readRows(
      `SELECT a.current_version_id AS pointer, v.number AS number,
              m.path AS entry, x.action AS action, i.version_id AS replayVersion,
              u.status AS upload, u.committed_version_id AS sealedVersion
       FROM artifacts a
       JOIN versions v ON v.id = a.current_version_id
       JOIN manifest_entries m ON m.version_id = v.id
       JOIN actions x ON x.version_id = v.id
       JOIN idempotency_records i ON i.version_id = v.id
       JOIN staged_uploads u ON u.committed_version_id = v.id
       WHERE a.id = ?`,
      base.artifact.id,
    )).toEqual([{
      action: "publish",
      entry: "index.html",
      number: 1,
      pointer: base.version.id,
      replayVersion: base.version.id,
      sealedVersion: base.version.id,
      upload: "committed",
    }]);
    await expectEveryEntryHasItsBlob();

    for (const [index, refusal] of newArtifactRefusals.entries()) {
      const content = `<h1>refused create ${index}</h1>`;
      const target = newArtifact(`atomic/create-${index}`);
      const key = `atomic-create-${refusal.label.replaceAll(" ", "-")}`;
      // eslint-disable-next-line no-await-in-loop
      const upload = await stage(content);
      const unchanged = snapshot();
      refuse(refusal);
      // eslint-disable-next-line no-await-in-loop
      const refused = await commit(upload, key, target);
      dropRefusal();
      expect(refused.status, `${refusal.label} refusal fails the create`).toBe(500);
      // eslint-disable-next-line no-await-in-loop
      await refused.arrayBuffer();
      expect(snapshot(), `${refusal.label} refusal leaves no create record`)
        .toEqual(unchanged);
      // eslint-disable-next-line no-await-in-loop
      const retried = await publishBody(await commit(upload, key, target));
      expect(retried.replayed).toBe(false);
      expect(retried.version.number).toBe(1);
      expect(retried.artifact.currentVersionId).toBe(retried.version.id);
      // eslint-disable-next-line no-await-in-loop
      const replay = await publishBody(await commit(upload, key, target), 200);
      expect(replay.replayed).toBe(true);
      expect({artifact: replay.artifact.id, version: replay.version.id})
        .toEqual({artifact: retried.artifact.id, version: retried.version.id});
    }

    let current = base.version;
    for (const [index, refusal] of newVersionRefusals.entries()) {
      const content = `<h1>refused version ${index}</h1>`;
      const target = newVersion(base.artifact.id, current.id);
      const key = `atomic-version-${refusal.label.replaceAll(" ", "-")}`;
      // eslint-disable-next-line no-await-in-loop
      const upload = await stage(content);
      const unchanged = snapshot();
      refuse(refusal);
      // eslint-disable-next-line no-await-in-loop
      const refused = await commit(upload, key, target);
      dropRefusal();
      expect(refused.status, `${refusal.label} refusal fails the version`).toBe(500);
      // eslint-disable-next-line no-await-in-loop
      await refused.arrayBuffer();
      expect(snapshot(), `${refusal.label} refusal leaves no version record`)
        .toEqual(unchanged);
      // eslint-disable-next-line no-await-in-loop
      const retried = await publishBody(await commit(upload, key, target));
      expect(retried.replayed).toBe(false);
      expect(retried.version.number).toBe(current.number + 1);
      expect(retried.artifact.currentVersionId).toBe(retried.version.id);
      // eslint-disable-next-line no-await-in-loop
      const replay = await publishBody(await commit(upload, key, target), 200);
      expect(replay.version.id).toBe(retried.version.id);
      current = retried.version;
    }

    const staleUpload = await stage("<h1>stale version</h1>");
    const unchanged = snapshot();
    const stale = await commit(
      staleUpload,
      "atomic-stale-version",
      newVersion(base.artifact.id, base.version.id),
    );
    expect(stale.status).toBe(409);
    await stale.arrayBuffer();
    expect(snapshot()).toEqual(unchanged);
    await expectEveryEntryHasItsBlob();
  });

  test("ARC-004-B ARC-004-F: blobs are durable before any record, a failure leaves at most a content-addressed blob, and a committed blob is never rewritten", async () => {
    const firstContent = "<h1>committed bytes</h1>";
    const first = await publishBody(await publish(
      firstContent,
      newArtifact("order/first"),
      "order-first-create",
    ));
    const firstBlob = blobPath(firstContent);
    const committedFile = await stat(firstBlob);
    const committedBytes = await readFile(firstBlob);

    // A file where the blob's shard directory belongs makes the blob write fail.
    const blockedContent = contentOutsideShardOf(firstContent, "blocked new artifact");
    const blockedTarget = newArtifact("order/blocked");
    const blockedUpload = await stage(blockedContent);
    const shard = path.dirname(blobPath(blockedContent));
    const blockedVersionContent = contentOutsideShardOf(firstContent, "blocked version", shard);
    const blockedVersionUpload = await stage(blockedVersionContent);
    const versionShard = path.dirname(blobPath(blockedVersionContent));
    const blockedVersionTarget = newVersion(first.artifact.id, first.version.id);
    await writeFile(shard, "not a directory");
    await writeFile(versionShard, "not a directory");
    const unchanged = snapshot();
    const blocked = await commit(blockedUpload, "order-blocked-create", blockedTarget);
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBeGreaterThanOrEqual(500);
    await blocked.arrayBuffer();
    expect(snapshot(), "a failed blob write records no artifact or version")
      .toEqual(unchanged);

    const blockedVersion = await commit(
      blockedVersionUpload,
      "order-blocked-version",
      blockedVersionTarget,
    );
    expect(blockedVersion.ok).toBe(false);
    await blockedVersion.arrayBuffer();
    expect(snapshot(), "a failed blob write leaves the current pointer alone")
      .toEqual(unchanged);

    await rm(shard);
    await rm(versionShard);
    await expectOnlyContentAddressedBlobs();
    const recovered = await publishBody(
      await commit(blockedUpload, "order-blocked-create", blockedTarget),
    );
    expect(recovered.replayed).toBe(false);
    const recoveredVersion = await publishBody(await commit(
      blockedVersionUpload,
      "order-blocked-version",
      blockedVersionTarget,
    ));
    expect(recoveredVersion.version.number).toBe(2);
    await expectEveryEntryHasItsBlob();

    // A transaction that fails after the blob write leaves only that blob.
    const orphanContent = "<h1>blob without a record</h1>";
    const orphanUpload = await stage(orphanContent);
    const beforeOrphan = snapshot();
    refuse({event: "BEFORE INSERT ON versions", label: "version row"});
    const orphaned = await commit(
      orphanUpload,
      "order-orphan-create",
      newArtifact("order/orphan"),
    );
    dropRefusal();
    expect(orphaned.status).toBe(500);
    await orphaned.arrayBuffer();
    expect(snapshot()).toEqual(beforeOrphan);
    await expectOnlyContentAddressedBlobs();
    expect(await readFile(blobPath(orphanContent), "utf8")).toBe(orphanContent);
    expect(readRows(
      "SELECT count(*) AS count FROM manifest_entries WHERE sha256 = ?",
      sha256(orphanContent),
    )).toEqual([{count: 0}]);

    const identical = await publishBody(await publish(
      firstContent,
      newArtifact("order/identical"),
      "order-identical-create",
    ));
    expect(identical.version.manifestDigest).toBe(first.version.manifestDigest);
    const afterIdentical = await stat(firstBlob);
    expect({ino: afterIdentical.ino, mtimeMs: afterIdentical.mtimeMs})
      .toEqual({ino: committedFile.ino, mtimeMs: committedFile.mtimeMs});
    expect(await readFile(firstBlob)).toEqual(committedBytes);
    await expectEveryEntryHasItsBlob();
  });

  interface StagedPublication {
    readonly commitUrl: string;
  }

  async function stage(content: string): Promise<StagedPublication> {
    const file = htmlFile(content);
    const upload = await createStagedUpload(server, installation, file.path, [file]);
    expect(upload.response.status).toBe(201);
    const uploads = await uploadEveryStagedFile(installation, upload.body, [file]);
    expect(uploads.map((response) => response.ok)).toEqual([true]);
    return upload.body;
  }

  async function publish(
    content: string,
    target: CommitTarget,
    idempotencyKey: string,
  ): Promise<Response> {
    return commit(await stage(content), idempotencyKey, target);
  }

  function commit(
    upload: StagedPublication,
    idempotencyKey: string,
    target: CommitTarget,
  ): Promise<Response> {
    return fetch(upload.commitUrl, {
      body: JSON.stringify({target}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
  }

  function blobPath(content: string): string {
    const digest = sha256(content);
    return path.join(installation.dataDirectory, "blobs", digest.slice(0, 2), digest);
  }

  /** Every file under the blob root sits at its own digest, with no partial write left. */
  async function expectOnlyContentAddressedBlobs(): Promise<void> {
    const root = path.join(installation.dataDirectory, "blobs");
    const files = await readdir(root, {recursive: true, withFileTypes: true});
    const blobs = files.filter((entry) => !entry.isDirectory());
    expect(blobs.length).toBeGreaterThan(0);
    await Promise.all(blobs.map(async (entry) => {
      const relative = path.relative(root, path.join(entry.parentPath, entry.name));
      const bytes = await readFile(path.join(root, relative));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(relative).toBe(path.join(digest.slice(0, 2), digest));
    }));
  }

  async function expectEveryEntryHasItsBlob(): Promise<void> {
    const entries = z.array(manifestEntrySchema).parse(
      readRows("SELECT sha256, size FROM manifest_entries"),
    );
    expect(entries.length).toBeGreaterThan(0);
    await Promise.all(entries.map(async (entry) => {
      const bytes = await readFile(path.join(
        installation.dataDirectory,
        "blobs",
        entry.sha256.slice(0, 2),
        entry.sha256,
      ));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      expect(bytes.byteLength).toBe(entry.size);
    }));
  }

  function refuse(refusal: Refusal): void {
    withDatabase((database) => {
      database.exec(
        `CREATE TRIGGER publication_outage
         ${refusal.event}
         BEGIN
           SELECT RAISE(ABORT, 'the ${refusal.label} write was refused');
         END;`,
      );
    });
  }

  function dropRefusal(): void {
    withDatabase((database) => {
      database.exec("DROP TRIGGER publication_outage;");
    });
  }

  function snapshot(): Snapshot {
    const tables = publicationTables.map((table) =>
      [table, readRows(`SELECT * FROM ${table} ORDER BY rowid`)] as const
    );
    return Object.fromEntries(tables);
  }

  function readRows(query: string, ...parameters: string[]): unknown[] {
    let rows: unknown[] = [];
    withDatabase((database) => {
      rows = database.prepare(query).all(...parameters);
    });
    return rows;
  }

  function withDatabase(operation: (database: DatabaseSync) => void): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }
});

function htmlFile(content: string): TestSiteFile {
  return {
    bytes: new TextEncoder().encode(content),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Content whose blob shard differs from `committed`'s and from `taken`. */
function contentOutsideShardOf(committed: string, label: string, taken?: string): string {
  const usedShards = new Set([sha256(committed).slice(0, 2)]);
  if (taken !== undefined) usedShards.add(path.basename(taken));
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `<h1>${label} ${attempt}</h1>`;
    if (!usedShards.has(sha256(candidate).slice(0, 2))) return candidate;
  }
}

function newArtifact(artifactPath: string): CommitTarget {
  return {
    accessSetting: "account_required",
    kind: "new_artifact",
    name: `Atomic ${artifactPath}`,
    path: artifactPath,
    tags: ["atomic"],
  };
}

function newVersion(artifactId: string, expectedCurrentVersionId: string): CommitTarget {
  return {artifactId, expectedCurrentVersionId, kind: "new_version"};
}

async function publishBody(response: Response, status = 201): Promise<PublishResponse> {
  const body = await response.text();
  expect({body, status: response.status}).toMatchObject({status});
  return parsePublishResponse(JSON.parse(body));
}
