import {randomUUID} from "node:crypto";

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
import {
  createStagedUpload,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const publishedSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string(),
    id: z.string(),
    path: z.string().nullable(),
  }).loose(),
  replayed: z.boolean(),
}).loose();
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

type CommitTarget =
  | {
    readonly accessSetting: "public_link";
    readonly kind: "new_artifact";
    readonly name: string;
    readonly path?: string;
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
    readonly path?: string;
  };

interface Attempt {
  readonly body: unknown;
  readonly commitUrl: string;
  readonly status: number;
}

/** Stage a one-file site and commit it, returning the raw response so refusals stay visible. */
async function commit(
  server: RunningTestServer,
  installation: TestInstallation,
  target: CommitTarget,
  idempotencyKey = `frk-006-${randomUUID()}`,
): Promise<Attempt> {
  const file = {
    bytes: new TextEncoder().encode(`<!doctype html><title>${randomUUID()}</title>`),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  };
  const planned = await createStagedUpload(server, installation, file.path, [file]);
  await uploadEveryStagedFile(installation, planned.body, [file]);
  return commitAt(installation, planned.body.commitUrl, target, idempotencyKey);
}

async function commitAt(
  installation: TestInstallation,
  commitUrl: string,
  target: CommitTarget,
  idempotencyKey: string,
): Promise<Attempt> {
  const response = await fetch(commitUrl, {
    body: JSON.stringify({target}),
    headers: apiHeaders(installation, idempotencyKey),
    method: "POST",
  });
  return {body: await response.json(), commitUrl, status: response.status};
}

function newArtifact(path?: string): CommitTarget {
  const target = {
    accessSetting: "public_link" as const,
    kind: "new_artifact" as const,
    name: `Report ${randomUUID()}`,
  };
  return path === undefined ? target : {...target, path};
}

function refusal(attempt: Attempt) {
  return {...errorBodySchema.parse(attempt.body).error, status: attempt.status};
}

describe("readable artifact paths at creation", () => {
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

  test("FRK-006-B: an HTTP create stores its normalized path, a new version keeps it, and a retried create replays", async () => {
    const idempotencyKey = `frk-006-${randomUUID()}`;
    const target = newArtifact("/2026/10/agent-console/");
    const created = await commit(server, installation, target, idempotencyKey);
    expect(created.status).toBe(201);
    const first = publishedSchema.parse(created.body);
    expect(first.artifact.path).toBe("2026/10/agent-console");

    const retried = await commitAt(installation, created.commitUrl, target, idempotencyKey);
    expect(retried.status).toBe(200);
    expect(publishedSchema.parse(retried.body)).toMatchObject({
      artifact: {id: first.artifact.id, path: "2026/10/agent-console"},
      replayed: true,
    });

    const versioned = await commit(server, installation, {
      artifactId: first.artifact.id,
      expectedCurrentVersionId: first.artifact.currentVersionId,
      kind: "new_version",
    });
    expect(versioned.status).toBe(201);
    expect(publishedSchema.parse(versioned.body).artifact).toMatchObject({
      id: first.artifact.id,
      path: "2026/10/agent-console",
    });

    const sibling = await commit(
      server,
      installation,
      newArtifact("2026/10/agent-console-v2"),
    );
    expect(sibling.status).toBe(201);
    expect(publishedSchema.parse(sibling.body).artifact.path)
      .toBe("2026/10/agent-console-v2");

    const pathless = await commit(server, installation, newArtifact());
    expect(pathless.status).toBe(201);
    expect(publishedSchema.parse(pathless.body).artifact.path).toBeNull();
  });

  test("FRK-006-F: overlapping, malformed, version-scoped, and host-mode paths are refused, and a deleted artifact frees its path", async () => {
    const held = await commit(server, installation, newArtifact("2026/10/agent-console"));
    expect(held.status).toBe(201);
    const holder = publishedSchema.parse(held.body);

    const overlaps = await Promise.all([
      "2026/10/agent-console",
      "2026/10",
      "2026/10/agent-console/shots",
    ].map(async (path) => refusal(await commit(server, installation, newArtifact(path)))));
    expect(overlaps).toEqual([
      {
        code: "ARTIFACT_PATH_TAKEN",
        message: 'The path "2026/10/agent-console" already belongs to another artifact.',
        status: 409,
      },
      {
        code: "ARTIFACT_PATH_TAKEN",
        message: 'The path "2026/10" overlaps the existing artifact path "2026/10/agent-console".',
        status: 409,
      },
      {
        code: "ARTIFACT_PATH_TAKEN",
        message: 'The path "2026/10/agent-console/shots" overlaps the existing artifact path "2026/10/agent-console".',
        status: 409,
      },
    ]);

    const raced = await Promise.all([
      commit(server, installation, newArtifact("2026/11/raced")),
      commit(server, installation, newArtifact("2026/11/raced")),
    ]);
    expect(
      raced.map(({status}) => status).toSorted((left, right) => left - right),
    ).toEqual([201, 409]);

    const malformed = await Promise.all([
      "api/report",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6/report",
      "2026/Oct",
      "2026//report",
      "a/b/c/d/e/f/g",
    ].map(async (path) => refusal(await commit(server, installation, newArtifact(path)))));
    expect(malformed).toEqual([
      {
        code: "INVALID_INPUT",
        message: 'The first path segment "api" is reserved by the application.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The first path segment "3fa85f64-5717-4562-b3fc-2c963f66afa6" has the shape of an artifact folder.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The path segment "Oct" may contain only lowercase letters, digits, and hyphens, and must not start with a hyphen.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'The artifact path "2026//report" has an empty segment.',
        status: 422,
      },
      {
        code: "INVALID_INPUT",
        message: 'An artifact path has at most 6 segments, and "a/b/c/d/e/f/g" has 7.',
        status: 422,
      },
    ]);

    const onVersion = await commit(server, installation, {
      artifactId: holder.artifact.id,
      expectedCurrentVersionId: holder.artifact.currentVersionId,
      kind: "new_version",
      path: "2026/12/elsewhere",
    });
    expect(refusal(onVersion)).toMatchObject({code: "INVALID_INPUT", status: 422});

    const reusedKey = `frk-006-${randomUUID()}`;
    const keyedTarget = newArtifact("2026/12/keyed");
    const keyed = await commit(server, installation, keyedTarget, reusedKey);
    expect(keyed.status).toBe(201);
    const rekeyed = await commitAt(
      installation,
      keyed.commitUrl,
      {...keyedTarget, path: "2026/12/rekeyed"},
      reusedKey,
    );
    expect(refusal(rekeyed)).toMatchObject({code: "IDEMPOTENCY_CONFLICT", status: 409});

    const deleted = await fetch(`${server.baseUrl}/api/v1/artifacts/${holder.artifact.id}`, {
      body: JSON.stringify({expectedCurrentVersionId: holder.artifact.currentVersionId}),
      headers: apiHeaders(installation, `frk-006-${randomUUID()}`),
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const reclaimed = await commit(server, installation, newArtifact("2026/10/agent-console"));
    expect(reclaimed.status).toBe(201);
    expect(publishedSchema.parse(reclaimed.body).artifact.path).toBe("2026/10/agent-console");

    const hostInstallation = await createTestInstallation();
    const hostServer = await startTestServer(hostInstallation);
    try {
      const hostMode = await commit(hostServer, hostInstallation, newArtifact("2026/10/report"));
      expect(refusal(hostMode)).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Readable artifact paths need a deployment without a content domain.",
        status: 501,
      });
    } finally {
      await hostServer.stop();
      await removeTestInstallation(hostInstallation);
    }
  });
});
