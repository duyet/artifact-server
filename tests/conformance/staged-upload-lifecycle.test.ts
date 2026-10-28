import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultAssetQuota} from "../../src/core/asset-policy.js";
import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {ArtifactAssetService} from "../../src/application/artifact-assets.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import {ExpiredStagingCleanupService} from
  "../../src/application/expired-staging-cleanup.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {Clock} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("staged upload lifecycle", () => {
  let clock: ControlledClock;
  let dataDirectory: string;
  let blobs: LocalBlobStore;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;
  let staging: LocalStagingStore;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-upload-lifecycle-"));
    clock = new ControlledClock(new Date("2026-08-13T00:00:00.000Z"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    blobs = new LocalBlobStore(path.join(dataDirectory, "blobs"));
    repository = new SqliteArtifactRepository(databasePath, "test-installation");
    identityRepository = new SqliteIdentityRepository(databasePath);
    staging = new LocalStagingStore(path.join(dataDirectory, "staging"));
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      assetQuota: defaultAssetQuota,
      blobs,
      bootstrapAdministratorEmail: "admin@example.test",
      clock,
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalMcpBearerVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: "test-installation",
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      publicLinks: "allowed",
      repository,
      staging,
    }));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("PUB-001-F: another principal or installation cannot use a staged upload", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("isolated upload");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const upload = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    const slot = upload.files[0];
    if (slot === undefined) throw new Error("The principal fixture has no file slot.");

    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        declaredLength: null,
        principal: testPrincipal("principal-b"),
        storageToken: slot.storageToken,
        uploadId: upload.id,
      })
    );
    await expectStagedFailure(runtime, "UploadNotFound", (service) =>
      service.commitUpload({
        idempotencyKey: "other-principal-cannot-commit",
        principal: testPrincipal("principal-b"),
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Must not commit",
          path: null,
        },
        uploadId: upload.id,
      })
    );

    const foreignRepository = new SqliteArtifactRepository(
      path.join(dataDirectory, "foreign-installation.db"),
    );
    const foreignIdentityRepository = new SqliteIdentityRepository(
      path.join(dataDirectory, "foreign-installation.db"),
    );
    try {
      const foreignRuntime: ApplicationRuntime = ManagedRuntime.make(
        createLocalApplicationLayer({
          apiToken: Redacted.make("foreign-api-token"),
          assetQuota: defaultAssetQuota,
          blobs: new LocalBlobStore(path.join(dataDirectory, "foreign-blobs")),
          bootstrapAdministratorEmail: "foreign-admin@example.test",
          clock,
          dispatches: foreignRepository,
          externalApiBearerVerifier: null,
          externalMcpBearerVerifier: null,
          ids: new SystemIdGenerator(),
          identityRepository: foreignIdentityRepository,
          installationId: "foreign-installation",
          localBootstrapCredential: null,
          protectBootstrapAdministrator: false,
          publicLinks: "allowed",
          repository: foreignRepository,
          staging: new LocalStagingStore(path.join(dataDirectory, "foreign-staging")),
        }),
      );
      await foreignRuntime.context();
      try {
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.uploadFile({
            body: byteStream(bytes),
            declaredLength: null,
            principal: testPrincipal(
              upload.principalId,
              "foreign-installation",
            ),
            storageToken: slot.storageToken,
            uploadId: upload.id,
          }),
        );
        await expectStagedFailure(
          foreignRuntime,
          "UploadNotFound",
          (service) => service.commitUpload({
            idempotencyKey: "foreign-installation-cannot-commit",
            principal: testPrincipal(
              upload.principalId,
              "foreign-installation",
            ),
            target: {
              accessSetting: "public_link",
              kind: "new_artifact",
              name: "Must not commit",
              path: null,
            },
            uploadId: upload.id,
          }),
        );
      } finally {
        await foreignRuntime.dispose();
      }
    } finally {
      foreignIdentityRepository.close();
      foreignRepository.close();
    }
  });

  test("expiry closes only uncommitted staging while committed retries remain stable", async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("staged lifecycle proof");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const expired = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    const expiredSlot = expired.files[0];
    if (expiredSlot === undefined) throw new Error("The expiry fixture has no file slot.");
    clock.set(new Date(expired.expiresAt));

    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.uploadFile({
        body: byteStream(bytes),
        declaredLength: null,
        principal: testPrincipal(expired.principalId),
        storageToken: expiredSlot.storageToken,
        uploadId: expired.id,
      })
    );
    await expectStagedFailure(runtime, "UploadExpired", (service) =>
      service.commitUpload({
        idempotencyKey: "expired-upload-cannot-commit",
        principal: testPrincipal(expired.principalId),
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name: "Expired upload",
          path: null,
        },
        uploadId: expired.id,
      })
    );

    clock.set(new Date("2026-08-13T02:00:00.000Z"));
    const live = await runStaged(runtime, (service) =>
      service.createUpload({
        entryPath: file.path,
        files: [file],
        principal: testPrincipal("principal-a"),
      })
    );
    const liveSlot = live.files[0];
    if (liveSlot === undefined) throw new Error("The commit fixture has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      declaredLength: null,
      principal: testPrincipal(live.principalId),
      storageToken: liveSlot.storageToken,
      uploadId: live.id,
    }));
    const target = {
      accessSetting: "public_link" as const,
      kind: "new_artifact" as const,
      name: "Committed upload",
      path: null,
    };
    const committed = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principal: testPrincipal(live.principalId),
      target,
      uploadId: live.id,
    }));

    clock.set(new Date(live.expiresAt));
    await rm(path.join(dataDirectory, "staging", live.id), {
      force: true,
      recursive: true,
    });
    const replay = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "committed-upload-stable-retry",
      principal: testPrincipal(live.principalId),
      target,
      uploadId: live.id,
    }));
    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(committed.version.id);

    await expectStagedFailure(runtime, "UploadClosed", (service) =>
      service.commitUpload({
        idempotencyKey: "committed-upload-new-command",
        principal: testPrincipal(live.principalId),
        target,
        uploadId: live.id,
      })
    );
  });

  test("foundation: an asset commit ends its staged upload once, a stale claim is refused in the transaction, and expiry cleanup reclaims the bytes", async () => {
    const principal = testPrincipal("asset-principal");
    const page = new TextEncoder().encode("<h1>asset host</h1>");
    const pageUpload = await runStaged(runtime, (service) => service.createUpload({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html",
        path: "index.html",
        sha256: createHash("sha256").update(page).digest("hex"),
        size: page.byteLength,
      }],
      principal,
    }));
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(page),
      declaredLength: null,
      principal,
      storageToken: pageUpload.files[0]?.storageToken ?? "",
      uploadId: pageUpload.id,
    }));
    const host = await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "asset-host-page-publish",
      principal,
      target: {accessSetting: "public_link", kind: "new_artifact", name: "Asset host", path: null},
      uploadId: pageUpload.id,
    }));

    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const planned = await runtime.runPromise(ArtifactAssetService.use((assets) =>
      assets.createUpload({
        artifactId: host.artifact.id,
        mediaType: "image/png",
        name: "chart.png",
        principal,
        projectId: host.artifact.projectId,
        sha256,
        size: bytes.byteLength,
      })));
    const slot = planned.files[0];
    if (slot === undefined) throw new Error("The asset plan has no file slot.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      declaredLength: null,
      principal,
      storageToken: slot.storageToken,
      uploadId: planned.id,
    }));
    const committed = await runtime.runPromise(ArtifactAssetService.use((assets) =>
      assets.commitUpload({
        artifactId: host.artifact.id,
        idempotencyKey: "asset-ends-upload-once-first",
        principal,
        projectId: host.artifact.projectId,
        uploadId: planned.id,
      })));
    expect(committed.replayed).toBe(false);

    // A second committer that read the upload before the first one ended it
    // still holds the old deadline, and its clock may run behind; the
    // transaction must refuse it even though its time is before the end.
    await expect(repository.commitAsset({
      asset: {
        ...committed.asset,
        createdAt: new Date(Date.parse(committed.asset.createdAt) - 1).toISOString(),
        id: new SystemIdGenerator().assetId(),
      },
      authorizedByPrincipalId: null,
      idempotencyKey: "asset-ends-upload-once-stale",
      inputDigest: "stale-claim",
      quota: defaultAssetQuota,
      upload: {expiresAt: planned.expiresAt, id: planned.id, principalId: principal.id},
    })).rejects.toMatchObject({_tag: "UploadClosed"});
    const listed = await repository.listAssets(host.artifact.projectId, host.artifact.id);
    expect(listed.assets.map((asset) => asset.id)).toEqual([committed.asset.id]);

    clock.set(new Date(clock.now().getTime() + 10 * 60 * 1_000));
    const report = await runCleanup(runtime, 100);
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    await expect(repository.findStagedUpload(planned.projectId, planned.id, principal.id))
      .resolves.toBeNull();
    await expect(staging.open(planned.id, slot.storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);
    const served = await blobs.open(sha256);
    expect(new Uint8Array(await new Response(served.body).arrayBuffer())).toEqual(bytes);
  });

  test("PUB-009-B OPS-006-F: cleanup is bounded, waits for settle, tolerates concurrent passes, and preserves committed work", async () => {
    const bytes = new TextEncoder().encode("cleanup lifecycle proof");
    const file = {
      mediaType: "text/plain",
      path: "proof.txt",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
    const expired = await runStaged(runtime, (service) => service.createUpload({
      entryPath: file.path,
      files: [file],
      principal: testPrincipal("cleanup-principal"),
    }));
    const expiredFile = expired.files[0];
    if (expiredFile === undefined) throw new Error("The cleanup fixture has no file.");
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      declaredLength: null,
      principal: testPrincipal(expired.principalId),
      storageToken: expiredFile.storageToken,
      uploadId: expired.id,
    }));

    const committedUpload = await runStaged(runtime, (service) => service.createUpload({
      entryPath: file.path,
      files: [file],
      principal: testPrincipal("cleanup-principal"),
    }));
    const committedFile = committedUpload.files[0];
    if (committedFile === undefined) {
      throw new Error("The committed cleanup fixture has no file.");
    }
    await runStaged(runtime, (service) => service.uploadFile({
      body: byteStream(bytes),
      declaredLength: null,
      principal: testPrincipal(committedUpload.principalId),
      storageToken: committedFile.storageToken,
      uploadId: committedUpload.id,
    }));
    await runStaged(runtime, (service) => service.commitUpload({
      idempotencyKey: "cleanup-preserves-committed-work",
      principal: testPrincipal(committedUpload.principalId),
      target: {
        accessSetting: "account_required",
        kind: "new_artifact",
        name: "Committed cleanup control",
        path: null,
      },
      uploadId: committedUpload.id,
    }));

    clock.set(new Date(new Date(expired.expiresAt).getTime() + 5 * 60 * 1_000 - 1));
    const tooEarly = await runCleanup(runtime, 100);
    expect(tooEarly).toEqual({
      alreadyAbsent: 0,
      deleted: 0,
      failed: 0,
      remaining: 0,
      selected: 0,
    });
    const beforeCleanup = await staging.open(expired.id, expiredFile.storageToken);
    expect(beforeCleanup.size).toBe(bytes.byteLength);
    await beforeCleanup.body.cancel();

    clock.set(new Date(new Date(expired.expiresAt).getTime() + 5 * 60 * 1_000));
    const concurrent = await Promise.all([
      runCleanup(runtime, 100),
      runCleanup(runtime, 100),
    ]);
    expect(concurrent.reduce((sum, report) => sum + report.deleted, 0)).toBe(1);
    expect(concurrent.reduce((sum, report) => sum + report.failed, 0)).toBe(0);
    await expect(repository.findStagedUpload(
      expired.projectId,
      expired.id,
      expired.principalId,
    )).resolves.toBeNull();
    await expect(staging.open(expired.id, expiredFile.storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);

    await expect(repository.findStagedUpload(
      committedUpload.projectId,
      committedUpload.id,
      committedUpload.principalId,
    )).resolves.toMatchObject({status: "committed"});
    const committedBytes = await staging.open(
      committedUpload.id,
      committedFile.storageToken,
    );
    expect(committedBytes.size).toBe(bytes.byteLength);
    await committedBytes.body.cancel();
    const immutableBlob = await blobs.open(file.sha256);
    expect(new Uint8Array(await new Response(immutableBlob.body).arrayBuffer()))
      .toEqual(bytes);
  });

  test("foundation: an interrupted local write cannot reappear after cleanup", async () => {
    const declaredBytes = new Uint8Array(1024 * 1024);
    const controller = new AbortController();
    const incoming = new TransformStream<Uint8Array, Uint8Array>();
    const writer = incoming.writable.getWriter();
    const uploadId = "upl_00000000-0000-4000-8000-000000000001";
    const storageToken = "a".repeat(36);
    const write = staging.put({
      body: incoming.readable,
      sha256: createHash("sha256").update(declaredBytes).digest("hex"),
      signal: controller.signal,
      size: declaredBytes.byteLength,
      storageToken,
      uploadId,
    });
    await writer.write(declaredBytes.subarray(0, 64 * 1024));
    controller.abort(new Error("staging deadline reached"));
    await writer.abort(controller.signal.reason).catch(() => undefined);
    await expect(write).rejects.toThrow(/deadline|abort/u);

    await staging.remove(uploadId, storageToken);
    await expect(staging.open(uploadId, storageToken)).rejects
      .toThrow(/ENOENT|no such file/u);
  });
});

function testPrincipal(
  id: string,
  installationId = "test-installation",
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [
      principalCapabilities.createArtifact,
      principalCapabilities.issueContentSession,
      principalCapabilities.publishAnyArtifact,
    ],
    displayName: "Staged upload fixture",
    id,
    installationId,
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}

class ControlledClock implements Clock {
  #current: Date;

  constructor(initial: Date) {
    this.#current = initial;
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(current: Date): void {
    this.#current = current;
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function runStaged<A, E>(
  runtime: ApplicationRuntime,
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(StagedUploadService.use(operation));
}

function runCleanup(
  runtime: ApplicationRuntime,
  limit: number,
) {
  return runtime.runPromise(ExpiredStagingCleanupService.use((service) =>
    service.runPass({limit})));
}

async function expectStagedFailure<A, E extends {_tag: string}>(
  runtime: ApplicationRuntime,
  expectedTag: E["_tag"],
  operation: (
    service: StagedUploadService["Service"],
  ) => Effect.Effect<A, E>,
): Promise<void> {
  const result = await runtime.runPromise(
    Effect.result(StagedUploadService.use(operation)),
  );
  const actualTag = Result.match(result, {
    onFailure: (failure) => failure._tag,
    onSuccess: () => "UnexpectedSuccess",
  });
  expect(actualTag).toBe(expectedTag);
}
