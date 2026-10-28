import {execFile} from "node:child_process";
import {randomBytes, randomUUID} from "node:crypto";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {request} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const apiToken =
  `as_key_key_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
const browserToken = "oci-browser-token-abcdefghijklmnopqrstuvwxyz012345";
const applicationOrigin = "https://artifacts.example.com";
const contentDomain = "content.example.net";
const sensitiveValues = new Set([apiToken, browserToken]);
const runtimeResources = {
  containers: new Set<string>(),
  directories: new Set<string>(),
  networks: new Set<string>(),
  volumes: new Set<string>(),
};

const imageManifestSchema = z.object({
  archive: z.string().endsWith(".oci.tar"),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  archiveSizeBytes: z.number().int().positive(),
  attestations: z.number().int().min(2),
  attestationPredicates: z.tuple([
    z.literal("https://spdx.dev/Document"),
    z.literal("https://slsa.dev/provenance/v1"),
  ]),
  imageIndexDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  platforms: z.array(z.object({
    architecture: z.enum(["amd64", "arm64"]),
    configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    kind: z.literal("image"),
    manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    operatingSystem: z.literal("linux"),
  })).length(2),
  product: z.literal("artifact-server"),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  schemaVersion: z.literal(1),
  sourceTreeClean: z.boolean(),
  version: z.string().min(1),
});
const compactDataDirectory = "/var/lib/artifact-server/data";
const commandFailureSchema = z.object({code: z.number().int()});
const jsonValueSchema = z.json();
const integrityStatusSchema = z.object({
  problems: z.array(z.looseObject({code: z.string()})),
  status: z.enum(["corrupt", "healthy"]),
});
const integritySchema = integrityStatusSchema.extend({
  artifactsChecked: z.number().int().nonnegative(),
  versionsChecked: z.number().int().nonnegative(),
});
const initializationSchema = z.object({
  installationId: z.string().startsWith("inst_"),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const supportManifestSchema = z.object({
  adapters: z.object({
    database: z.enum(["postgres", "sqlite"]),
    objectStorage: z.enum(["filesystem", "s3"]),
  }),
  imageRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  installationId: z.string(),
  product: z.literal("artifact-server"),
  providers: z.object({status: z.literal("ready")}),
});
const runtimeMeasurementSchema = z.object({
  concurrentReads: z.number().int().positive(),
  providerStartupMilliseconds: z.number().nonnegative().optional(),
  readMilliseconds: z.number().nonnegative(),
  startupMilliseconds: z.number().nonnegative(),
});
const runtimeBaselineSchema = z.object({
  compact: runtimeMeasurementSchema.optional(),
  externalStorage: runtimeMeasurementSchema.optional(),
  measuredAt: z.string().optional(),
  node: z.string().optional(),
  platform: z.string().optional(),
});
type RuntimeMeasurement = z.infer<typeof runtimeMeasurementSchema>;

afterEach(async () => {
  await Promise.all([...runtimeResources.containers].map(removeContainer));
  await Promise.all([...runtimeResources.volumes].map(removeVolume));
  await Promise.all([...runtimeResources.networks].map(removeNetwork));
  await Promise.all([...runtimeResources.directories].map((directory) =>
    rm(directory, {force: true, recursive: true})
  ));
});

describe.sequential("production OCI image", () => {
  test("OCI foundation: the attested release runs as its fixed user on AMD64 and ARM64", async () => {
    const environment = ociEnvironment();
    const manifest = imageManifestSchema.parse(JSON.parse(
      await readFile(environment.manifestPath, "utf8"),
    ));
    expect(path.basename(environment.archivePath)).toBe(manifest.archive);
    expect(manifest.revision).toBe(environment.revision);
    expect(manifest.platforms.map(({architecture}) => architecture).toSorted())
      .toEqual(["amd64", "arm64"]);
    const loadedIndexId = (await docker([
      "image", "inspect", "--format", "{{.Id}}", environment.arm64Image,
    ])).stdout.trim();
    expect(loadedIndexId).toBe(manifest.imageIndexDigest);

    const runtimes = [
      {architecture: "arm64" as const, image: environment.arm64Image},
      {architecture: "amd64" as const, image: environment.amd64Image},
    ];
    await Promise.all(runtimes.map((runtime) => verifyArchitectureRuntime({
      expectedPlatform: manifest.platforms.find(
        ({architecture}) => architecture === runtime.architecture,
      ),
      image: runtime.image,
      platform: runtime.architecture,
      version: manifest.version,
    })));
  });

  test("OCI foundation: compact mode initializes, publishes, replaces, and stops cleanly", async () => {
    const environment = ociEnvironment();
    const nameSuffix = resourceSuffix();
    const volume = await createVolume(`artifact-server-oci-compact-${nameSuffix}`);
    const network = await createNetwork(`artifact-server-oci-compact-${nameSuffix}`);
    const dataRoot = "/var/lib/artifact-server";
    const dataDirectory = `${dataRoot}/data`;
    const initResult = await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--volume", `${volume}:${dataRoot}`,
      environment.arm64Image,
      "init", "--admin-email", "admin@example.test", "--data", dataDirectory,
    ]);
    const initialization = initializationSchema.parse(JSON.parse(initResult.stdout));
    const storedApiToken = (await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--volume", `${volume}:${dataRoot}:ro`,
      "--entrypoint", "/bin/sh",
      environment.arm64Image,
      "-c", `cat ${dataDirectory}/secrets/api-token`,
    ])).stdout.trim();
    expect(storedApiToken).toMatch(
      /^as_key_key_[0-9a-f-]+_[A-Za-z0-9_-]{32,}$/u,
    );
    registerSensitiveValue(storedApiToken);

    const firstName = `artifact-server-oci-compact-first-${nameSuffix}`;
    const firstStartedAt = performance.now();
    const firstPort = await startCompactContainer({
      containerName: firstName,
      network,
      runtime: arm64Runtime(environment),
      volume,
    });
    const firstStartupMilliseconds = performance.now() - firstStartedAt;
    const publication = await publishFixture({
      apiToken: storedApiToken,
      containerImage: environment.arm64Image,
      network,
      serverOrigin: `http://${firstName}:8787`,
      text: "compact OCI bytes\n",
    });
    expect(publication.artifact.name).toBe("proof.txt");
    expect(await fetchContent(publication.links.version, firstPort))
      .toBe("compact OCI bytes\n");
    const firstReads = await boundedReadProbe(publication.links.version, firstPort);
    expect((await docker(["diff", firstName])).stdout.trim()).toBe("");
    expect(await stopContainer(firstName)).toBe(0);

    const secondName = `artifact-server-oci-compact-second-${nameSuffix}`;
    const secondPort = await startCompactContainer({
      containerName: secondName,
      network,
      runtime: arm64Runtime(environment),
      volume,
    });
    expect(await fetchContent(publication.links.version, secondPort))
      .toBe("compact OCI bytes\n");
    expect(await stopContainer(secondName)).toBe(0);

    const support = await runCompactSupportManifest({
      runtime: arm64Runtime(environment),
      volume,
    });
    expect(support).toMatchObject({
      adapters: {database: "sqlite", objectStorage: "filesystem"},
      imageRevision: environment.revision,
      installationId: initialization.installationId,
    });
    expect(JSON.stringify(support)).not.toContain(storedApiToken);

    await recordRuntimeBaseline("compact", {
      concurrentReads: firstReads.count,
      readMilliseconds: firstReads.milliseconds,
      startupMilliseconds: firstStartupMilliseconds,
    });
  });

  test("DEP-020-B: the external-storage image migrates, publishes, and replaces its container with exact state and no local data", async () => {
    const environment = ociEnvironment();
    const providers = providerEnvironment();
    const nameSuffix = resourceSuffix();
    const bucket = `artifact-server-oci-${nameSuffix}`;
    const installationId = `oci-external-${nameSuffix}`;
    const s3Client = new S3Client({
      credentials: {
        accessKeyId: providers.accessKey,
        secretAccessKey: providers.secretKey,
      },
      endpoint: providers.hostS3Endpoint,
      forcePathStyle: true,
      region: "us-east-1",
    });
    try {
      await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
    } finally {
      s3Client.destroy();
    }

    const externalEnvironment = externalRuntimeEnvironment({
      bucket,
      installationId,
      providers,
    });
    await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--network", providers.dockerNetwork,
      ...containerEnvironmentArguments(externalEnvironment),
      environment.arm64Image,
      "migrate", "apply",
    ], externalEnvironment);

    const firstName = `artifact-server-oci-external-first-${nameSuffix}`;
    const firstStartedAt = performance.now();
    const firstPort = await startExternalContainer({
      containerName: firstName,
      environment,
      externalEnvironment,
      network: providers.dockerNetwork,
    });
    const firstStartupMilliseconds = performance.now() - firstStartedAt;
    const publication = await publishFixture({
      apiToken,
      containerImage: environment.arm64Image,
      network: providers.dockerNetwork,
      serverOrigin: `http://${firstName}:8787`,
      text: "external OCI bytes\n",
    });
    expect(await fetchContent(publication.links.version, firstPort))
      .toBe("external OCI bytes\n");
    const firstSnapshot = await fetchStateSnapshot(firstPort, apiToken, [publication]);
    const firstReads = await boundedReadProbe(publication.links.version, firstPort);
    expect((await docker(["diff", firstName])).stdout.trim()).toBe("");
    expect(await stopContainer(firstName)).toBe(0);

    const secondName = `artifact-server-oci-external-second-${nameSuffix}`;
    const secondPort = await startExternalContainer({
      containerName: secondName,
      environment,
      externalEnvironment,
      network: providers.dockerNetwork,
    });
    expect(await fetchContent(publication.links.version, secondPort))
      .toBe("external OCI bytes\n");
    expect(await fetchStateSnapshot(secondPort, apiToken, [publication]))
      .toEqual(firstSnapshot);
    expect(await stopContainer(secondName)).toBe(0);

    const supportResult = await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--network", providers.dockerNetwork,
      ...containerEnvironmentArguments(externalEnvironment),
      environment.arm64Image,
      "support", "manifest", "--mode", "external-storage",
    ], externalEnvironment);
    const support = supportManifestSchema.parse(JSON.parse(supportResult.stdout));
    expect(support).toMatchObject({
      adapters: {database: "postgres", objectStorage: "s3"},
      imageRevision: environment.revision,
      installationId,
    });
    expect(supportResult.stdout).not.toContain(apiToken);
    expect(supportResult.stdout).not.toContain(providers.secretKey);

    await recordRuntimeBaseline("externalStorage", {
      concurrentReads: firstReads.count,
      providerStartupMilliseconds: providers.providerStartupMilliseconds,
      readMilliseconds: firstReads.milliseconds,
      startupMilliseconds: firstStartupMilliseconds,
    });
  });

  test("DEP-005-B OPS-003-B: the compact image keeps exact state through restart, replacement, backup, and restore", async () => {
    const runtime = amd64Runtime(ociEnvironment());
    const nameSuffix = resourceSuffix();
    const network = await createNetwork(`artifact-server-oci-state-${nameSuffix}`);
    const sourceVolume = await createVolume(`artifact-server-oci-state-source-${nameSuffix}`);
    const initialization = await initializeCompactVolume(runtime, sourceVolume);
    const storedApiToken = await readCompactApiToken(runtime, sourceVolume);

    const firstName = `artifact-server-oci-state-first-${nameSuffix}`;
    const firstPort = await startCompactContainer({
      containerName: firstName,
      network,
      runtime,
      volume: sourceVolume,
    });
    const publishInput = {
      apiToken: storedApiToken,
      architecture: runtime.architecture,
      containerImage: runtime.image,
      network,
      serverOrigin: `http://${firstName}:8787`,
    };
    const filePublication = await publishFixture({
      ...publishInput,
      text: "compact release file bytes\n",
    });
    const sitePublication = await publishFixture({
      ...publishInput,
      kind: "site",
      text: "compact release site",
    });
    expect(await fetchContent(sitePublication.links.version, firstPort))
      .toContain("compact release site");
    expect(await fetchContent(
      new URL("/assets/app.js", sitePublication.links.version).toString(),
      firstPort,
    )).toContain("dataset.release");
    const secondSitePublication = await publishFixture({
      ...publishInput,
      kind: "site",
      target: {
        artifactId: sitePublication.artifact.id,
        expectedVersionId: sitePublication.version.id,
      },
      text: "compact release site version two",
    });
    expect(secondSitePublication.artifact.id).toBe(sitePublication.artifact.id);
    expect(secondSitePublication.version.number).toBe(2);
    expect(await fetchContent(filePublication.links.version, firstPort))
      .toBe("compact release file bytes\n");
    const publications = [filePublication, sitePublication, secondSitePublication];
    const sourceSnapshot = await fetchStateSnapshot(firstPort, storedApiToken, publications);

    await docker(["restart", "--time", "8", firstName]);
    const restartedPort = await waitForReady(firstName);
    expect(await fetchStateSnapshot(restartedPort, storedApiToken, publications))
      .toEqual(sourceSnapshot);
    expect(await stopContainer(firstName)).toBe(0);

    const replacementName = `artifact-server-oci-state-replacement-${nameSuffix}`;
    const replacementPort = await startCompactContainer({
      containerName: replacementName,
      network,
      runtime,
      volume: sourceVolume,
    });
    expect(await fetchContent(secondSitePublication.links.version, replacementPort))
      .toContain("compact release site version two");
    expect(await fetchStateSnapshot(replacementPort, storedApiToken, publications))
      .toEqual(sourceSnapshot);
    expect(await stopContainer(replacementName)).toBe(0);

    const backupDirectory = await backupCompactVolume(runtime, sourceVolume);
    const restoredVolume = await createVolume(`artifact-server-oci-state-restored-${nameSuffix}`);
    await restoreCompactVolume(runtime, backupDirectory, restoredVolume);
    const restoredIntegrity = await runCompactIntegrityCheck(runtime, restoredVolume);
    expect(restoredIntegrity.exitCode).toBe(0);
    expect(integritySchema.parse(JSON.parse(restoredIntegrity.stdout))).toMatchObject({
      artifactsChecked: 2,
      problems: [],
      status: "healthy",
      versionsChecked: 3,
    });
    await runInCompactVolume(
      runtime,
      restoredVolume,
      `rm ${compactDataDirectory}/.restore-incomplete`,
    );

    const restoredName = `artifact-server-oci-state-restored-${nameSuffix}`;
    const restoredPort = await startCompactContainer({
      containerName: restoredName,
      network,
      runtime,
      volume: restoredVolume,
    });
    expect(await fetchContent(filePublication.links.version, restoredPort))
      .toBe("compact release file bytes\n");
    expect(await fetchContent(secondSitePublication.links.version, restoredPort))
      .toContain("compact release site version two");
    expect(await fetchStateSnapshot(restoredPort, storedApiToken, publications))
      .toEqual(sourceSnapshot);
    expect(await stopContainer(restoredName)).toBe(0);
    const restoredSupport = await runCompactSupportManifest({
      runtime,
      volume: restoredVolume,
    });
    expect(restoredSupport.installationId).toBe(initialization.installationId);
  });

  test("DEP-005-F: the compact image refuses a second container, ephemeral or uninitialized data, bad permissions, missing secrets, and invalid configuration", async () => {
    const runtime = amd64Runtime(ociEnvironment());
    const nameSuffix = resourceSuffix();
    const uninitialized = "The compact installation could not be read.";
    const network = await createNetwork(`artifact-server-oci-refusal-${nameSuffix}`);
    const volume = await createVolume(`artifact-server-oci-refusal-${nameSuffix}`);
    await initializeCompactVolume(runtime, volume);

    const firstName = `artifact-server-oci-refusal-first-${nameSuffix}`;
    const firstPort = await startCompactContainer({
      containerName: firstName,
      network,
      runtime,
      volume,
    });
    await expectStartRefused({
      arguments: compactStartArguments(runtime, volume),
      containerName: `artifact-server-oci-refusal-second-${nameSuffix}`,
      network,
      reason: "Another Artifact Server process is already serving",
      runtime,
    });
    expect(await isReady(firstPort)).toBe(true);
    await docker(["kill", firstName]);
    await removeContainer(firstName);
    const afterCrashName = `artifact-server-oci-refusal-after-crash-${nameSuffix}`;
    const afterCrashPort = await startCompactContainer({
      containerName: afterCrashName,
      network,
      runtime,
      volume,
    });
    expect(await isReady(afterCrashPort)).toBe(true);
    expect(await stopContainer(afterCrashName)).toBe(0);

    const ephemeralInit = await docker([
      "run", ...hardenedRunArguments(runtime.architecture),
      runtime.image,
      "init", "--admin-email", "admin@example.test", "--data", compactDataDirectory,
    ], {}, true);
    expect(ephemeralInit.exitCode).not.toBe(0);
    expect(ephemeralInit.stdout).not.toContain("installationId");
    await expectStartRefused({
      arguments: [
        runtime.image,
        "start-compact", "--data", "/tmp/data", "--host", "0.0.0.0", "--port", "8787",
      ],
      containerName: `artifact-server-oci-refusal-ephemeral-${nameSuffix}`,
      network,
      reason: uninitialized,
      runtime,
    });
    const uninitializedVolume = await createVolume(
      `artifact-server-oci-refusal-uninitialized-${nameSuffix}`,
    );
    await expectStartRefused({
      arguments: compactStartArguments(runtime, uninitializedVolume),
      containerName: `artifact-server-oci-refusal-uninitialized-${nameSuffix}`,
      network,
      reason: uninitialized,
      runtime,
    });

    await expectStartRefused({
      arguments: compactStartArguments(runtime, volume),
      containerName: `artifact-server-oci-refusal-domain-${nameSuffix}`,
      environment: {ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.com"},
      network,
      reason: "The application and published content must use different registrable domains.",
      runtime,
    });
    await expectStartRefused({
      arguments: compactStartArguments(runtime, volume),
      containerName: `artifact-server-oci-refusal-identity-${nameSuffix}`,
      environment: {ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test"},
      network,
      reason: "ARTIFACT_SERVER_OIDC_CLIENT_ID is required.",
      runtime,
    });

    const secretVolume = await createVolume(`artifact-server-oci-refusal-secret-${nameSuffix}`);
    await initializeCompactVolume(runtime, secretVolume);
    await runInCompactVolume(
      runtime,
      secretVolume,
      `rm ${compactDataDirectory}/secrets/api-token`,
    );
    await expectStartRefused({
      arguments: compactStartArguments(runtime, secretVolume),
      containerName: `artifact-server-oci-refusal-secret-${nameSuffix}`,
      network,
      reason: "The generated secret file for ARTIFACT_SERVER_API_TOKEN cannot be read.",
      runtime,
    });

    const deniedVolume = await createVolume(`artifact-server-oci-refusal-denied-${nameSuffix}`);
    await initializeCompactVolume(runtime, deniedVolume);
    await runInCompactVolume(runtime, deniedVolume, `chmod 000 ${compactDataDirectory}`);
    await expectStartRefused({
      arguments: compactStartArguments(runtime, deniedVolume),
      containerName: `artifact-server-oci-refusal-denied-${nameSuffix}`,
      network,
      reason: uninitialized,
      runtime,
    });
  });

  test("OPS-003-F: a compact restore that is unfinished, missing bytes, or holding changed bytes never reports ready", async () => {
    const runtime = amd64Runtime(ociEnvironment());
    const nameSuffix = resourceSuffix();
    const incompleteRestore = "The compact data directory contains an incomplete restore.";
    const network = await createNetwork(`artifact-server-oci-restore-${nameSuffix}`);
    const sourceVolume = await createVolume(`artifact-server-oci-restore-source-${nameSuffix}`);
    await initializeCompactVolume(runtime, sourceVolume);
    const storedApiToken = await readCompactApiToken(runtime, sourceVolume);
    const sourceName = `artifact-server-oci-restore-source-${nameSuffix}`;
    await startCompactContainer({
      containerName: sourceName,
      network,
      runtime,
      volume: sourceVolume,
    });
    await publishFixture({
      apiToken: storedApiToken,
      architecture: runtime.architecture,
      containerImage: runtime.image,
      network,
      serverOrigin: `http://${sourceName}:8787`,
      text: "restore failures must stay unavailable\n",
    });
    expect(await stopContainer(sourceName)).toBe(0);
    const backupDirectory = await backupCompactVolume(runtime, sourceVolume);

    const unfinishedVolume = await createVolume(
      `artifact-server-oci-restore-unfinished-${nameSuffix}`,
    );
    await restoreCompactVolume(runtime, backupDirectory, unfinishedVolume);
    await expectStartRefused({
      arguments: compactStartArguments(runtime, unfinishedVolume),
      containerName: `artifact-server-oci-restore-unfinished-${nameSuffix}`,
      network,
      reason: incompleteRestore,
      runtime,
    });

    const missingVolume = await createVolume(`artifact-server-oci-restore-missing-${nameSuffix}`);
    await restoreCompactVolume(runtime, backupDirectory, missingVolume);
    await runInCompactVolume(
      runtime,
      missingVolume,
      `find ${compactDataDirectory}/blobs -type f | head -n 1 | xargs rm`,
    );
    const missing = await runCompactIntegrityCheck(runtime, missingVolume);
    expect(missing.exitCode).toBe(2);
    expect(integrityStatusSchema.parse(JSON.parse(missing.stdout))).toMatchObject({
      problems: [{code: "blob_missing"}],
      status: "corrupt",
    });
    await expectStartRefused({
      arguments: compactStartArguments(runtime, missingVolume),
      containerName: `artifact-server-oci-restore-missing-${nameSuffix}`,
      network,
      reason: incompleteRestore,
      runtime,
    });

    const changedVolume = await createVolume(`artifact-server-oci-restore-changed-${nameSuffix}`);
    await restoreCompactVolume(runtime, backupDirectory, changedVolume);
    await runInCompactVolume(
      runtime,
      changedVolume,
      `blob=$(find ${compactDataDirectory}/blobs -type f | head -n 1); printf changed > "$blob"`,
    );
    const changed = await runCompactIntegrityCheck(runtime, changedVolume);
    expect(changed.exitCode).toBe(2);
    expect(integrityStatusSchema.parse(JSON.parse(changed.stdout)).status).toBe("corrupt");
    await expectStartRefused({
      arguments: compactStartArguments(runtime, changedVolume),
      containerName: `artifact-server-oci-restore-changed-${nameSuffix}`,
      network,
      reason: incompleteRestore,
      runtime,
    });
  });
});

type Architecture = "amd64" | "arm64";

interface ImageRuntime {
  readonly architecture: Architecture;
  readonly image: string;
}

function amd64Runtime(environment: OciEnvironment): ImageRuntime {
  return {architecture: "amd64", image: environment.amd64Image};
}

function arm64Runtime(environment: OciEnvironment): ImageRuntime {
  return {architecture: "arm64", image: environment.arm64Image};
}

async function initializeCompactVolume(
  runtime: ImageRuntime,
  volume: string,
): Promise<z.infer<typeof initializationSchema>> {
  const result = await docker([
    "run", ...hardenedRunArguments(runtime.architecture),
    "--volume", `${volume}:/var/lib/artifact-server`,
    runtime.image,
    "init", "--admin-email", "admin@example.test", "--data", compactDataDirectory,
  ]);
  return initializationSchema.parse(JSON.parse(result.stdout));
}

async function readCompactApiToken(runtime: ImageRuntime, volume: string): Promise<string> {
  const token = (await runInCompactVolume(
    runtime,
    volume,
    `cat ${compactDataDirectory}/secrets/api-token`,
  )).trim();
  registerSensitiveValue(token);
  return token;
}

async function runInCompactVolume(
  runtime: ImageRuntime,
  volume: string,
  script: string,
): Promise<string> {
  const result = await docker([
    "run", ...hardenedRunArguments(runtime.architecture),
    "--volume", `${volume}:/var/lib/artifact-server`,
    "--entrypoint", "/bin/sh",
    runtime.image,
    "-c", `set -eu; ${script}`,
  ]);
  return result.stdout;
}

async function backupCompactVolume(runtime: ImageRuntime, volume: string): Promise<string> {
  const backupDirectory = await temporaryDirectory("artifact-server-oci-backup-");
  await chmod(backupDirectory, 0o777);
  await docker([
    "run", ...hardenedRunArguments(runtime.architecture),
    "--volume", `${volume}:/var/lib/artifact-server:ro`,
    "--volume", `${backupDirectory}:/backup`,
    "--entrypoint", "/bin/tar",
    runtime.image,
    "-C", "/var/lib/artifact-server", "-cf", "/backup/data.tar", "data",
  ]);
  return backupDirectory;
}

async function restoreCompactVolume(
  runtime: ImageRuntime,
  backupDirectory: string,
  volume: string,
): Promise<void> {
  await docker([
    "run", ...hardenedRunArguments(runtime.architecture),
    "--volume", `${volume}:/var/lib/artifact-server`,
    "--volume", `${backupDirectory}:/backup:ro`,
    "--entrypoint", "/bin/sh",
    runtime.image,
    "-c", [
      "set -eu",
      `mkdir -m 700 ${compactDataDirectory}`,
      `printf 'Restore has not passed its integrity check.\\n' > ${compactDataDirectory}/.restore-incomplete`,
      "tar --no-same-owner -C /var/lib/artifact-server -xf /backup/data.tar",
    ].join("; "),
  ]);
}

function runCompactIntegrityCheck(
  runtime: ImageRuntime,
  volume: string,
): Promise<ProcessResult> {
  return docker([
    "run", ...hardenedRunArguments(runtime.architecture),
    "--volume", `${volume}:/var/lib/artifact-server`,
    runtime.image,
    "integrity", "check", "--mode", "compact", "--data", compactDataDirectory,
  ], {}, true);
}

async function expectStartRefused(input: {
  readonly arguments: readonly string[];
  readonly containerName: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly network: string;
  readonly reason: string;
  readonly runtime: ImageRuntime;
}): Promise<void> {
  await startContainer({
    architecture: input.runtime.architecture,
    arguments: input.arguments,
    containerName: input.containerName,
    environment: {...compactRuntimeEnvironment(), ...input.environment},
    network: input.network,
  });
  const state = await waitForExit(input.containerName, 300);
  const logs = await docker(["logs", input.containerName], {}, true);
  const output = redact(logs.stdout + logs.stderr);
  await removeContainer(input.containerName);
  expect({exitCode: state.exitCode, output}).not.toMatchObject({exitCode: 0});
  expect(output).not.toContain('"status":"ready"');
  expect(output).toContain(input.reason);
}

async function waitForExit(
  containerName: string,
  attemptsRemaining: number,
): Promise<{readonly exitCode: number; readonly running: boolean}> {
  const state = await containerState(containerName);
  if (!state.running) return state;
  if (attemptsRemaining <= 1) {
    throw new Error(`${containerName} kept running; it should have refused to start.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return waitForExit(containerName, attemptsRemaining - 1);
}

async function isReady(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
  } catch {
    return false;
  }
}

async function fetchStateSnapshot(
  port: number,
  token: string,
  publications: readonly z.infer<typeof publicationSchema>[],
): Promise<readonly z.infer<typeof jsonValueSchema>[]> {
  const resourcePaths = publications.flatMap((publication) => [
    `/api/v1/artifacts/${publication.artifact.id}`,
    `/api/v1/artifacts/${publication.artifact.id}/versions`,
    `/api/v1/artifacts/${publication.artifact.id}/actions`,
    `/api/v1/artifacts/${publication.artifact.id}/versions/${publication.version.id}`,
  ]);
  return Promise.all(resourcePaths.map(async (resourcePath) => {
    const response = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    expect({resourcePath, status: response.status}).toEqual({resourcePath, status: 200});
    const body = (await response.text()).replaceAll(`:${port}`, ":<published-port>");
    return jsonValueSchema.parse(JSON.parse(body));
  }));
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  runtimeResources.directories.add(directory);
  return directory;
}

interface OciEnvironment {
  readonly amd64Image: string;
  readonly archivePath: string;
  readonly arm64Image: string;
  readonly manifestPath: string;
  readonly revision: string;
}

interface ProviderEnvironment {
  readonly accessKey: string;
  readonly dockerDatabaseUrl: string;
  readonly dockerNetwork: string;
  readonly dockerS3Endpoint: string;
  readonly hostS3Endpoint: string;
  readonly providerStartupMilliseconds: number;
  readonly secretKey: string;
}

function ociEnvironment(): OciEnvironment {
  return {
    amd64Image: requiredEnvironment("ARTIFACT_SERVER_OCI_AMD64_IMAGE"),
    archivePath: requiredEnvironment("ARTIFACT_SERVER_OCI_ARCHIVE"),
    arm64Image: requiredEnvironment("ARTIFACT_SERVER_OCI_ARM64_IMAGE"),
    manifestPath: requiredEnvironment("ARTIFACT_SERVER_OCI_MANIFEST"),
    revision: requiredEnvironment("ARTIFACT_SERVER_OCI_REVISION"),
  };
}

function providerEnvironment(): ProviderEnvironment {
  const environment = {
    accessKey: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"),
    dockerDatabaseUrl: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_DATABASE_URL"),
    dockerNetwork: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_NETWORK"),
    dockerS3Endpoint: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_S3_ENDPOINT"),
    hostS3Endpoint: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ENDPOINT"),
    providerStartupMilliseconds: Number(
      requiredEnvironment("ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS"),
    ),
    secretKey: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_SECRET_KEY"),
  };
  registerSensitiveValue(environment.accessKey);
  registerSensitiveValue(environment.dockerDatabaseUrl);
  registerSensitiveValue(environment.secretKey);
  return environment;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Run this test through pnpm test:oci-image; ${name} is missing.`);
  }
  return value;
}

function hardenedRunArguments(architecture: Architecture): string[] {
  return [
    "--rm",
    "--platform", `linux/${architecture}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
  ];
}

async function verifyArchitectureRuntime(input: {
  readonly expectedPlatform: z.infer<typeof imageManifestSchema>["platforms"][number]
    | undefined;
  readonly image: string;
  readonly platform: "amd64" | "arm64";
  readonly version: string;
}): Promise<void> {
  if (input.expectedPlatform === undefined) {
    throw new Error(`The ${input.platform} image descriptor is missing.`);
  }
  const imageId = (await docker([
    "image", "inspect", "--platform", `linux/${input.platform}`,
    "--format", "{{.Id}}", input.image,
  ])).stdout.trim();
  expect(imageId).toBe(input.expectedPlatform.manifestDigest);

  const common = hardenedRunArguments(input.platform);
  const [version, identity, filesystem] = await Promise.all([
    docker(["run", ...common, input.image, "--version"]),
    docker([
      "run", ...common, "--entrypoint", "/usr/bin/id", input.image, "-u",
    ]),
    docker([
      "run", ...common, "--entrypoint", "/bin/sh", input.image, "-c",
      [
        "set -eu",
        "test ! -e src",
        "test ! -e tests",
        "test ! -e node_modules/typescript",
        "test ! -e node_modules/tsx",
        "test ! -e node_modules/vitest",
        "test ! -e node_modules/oxlint",
        "test -s dist/web/review.html",
        "test -s dist/web/review-frame.html",
        "find dist/web/assets -type f -name '*.js' -print -quit | grep -q .",
        "find dist/web/assets -type f -name '*.css' -print -quit | grep -q .",
        "test -r /usr/local/share/ca-certificates/aws-rds-global-bundle.pem",
        "test \"$(stat -c %a /usr/local/share/ca-certificates/aws-rds-global-bundle.pem)\" = 444",
        "mount_options=$(awk '$2 == \"/\" {print $4}' /proc/mounts)",
        "case \"$mount_options\" in *ro*) ;; *) exit 42 ;; esac",
        "touch /tmp/runtime-write-proof",
      ].join("; "),
    ]),
  ]);
  expect(version.stdout.trim()).toBe(input.version);
  expect(identity.stdout.trim()).toBe("1000");
  expect(filesystem.stdout).toBe("");
}

function compactRuntimeEnvironment() {
  return {
    ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
  } satisfies Readonly<Record<string, string>>;
}

function externalRuntimeEnvironment(input: {
  readonly bucket: string;
  readonly installationId: string;
  readonly providers: ProviderEnvironment;
}) {
  return {
    ARTIFACT_SERVER_API_TOKEN: apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
    ARTIFACT_SERVER_DATABASE_URL: input.providers.dockerDatabaseUrl,
    ARTIFACT_SERVER_INSTALLATION_ID: input.installationId,
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: input.providers.accessKey,
    ARTIFACT_SERVER_S3_BUCKET: input.bucket,
    ARTIFACT_SERVER_S3_ENDPOINT: input.providers.dockerS3Endpoint,
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: input.providers.secretKey,
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
  } satisfies Readonly<Record<string, string>>;
}

async function startCompactContainer(input: {
  readonly containerName: string;
  readonly network: string;
  readonly runtime: ImageRuntime;
  readonly volume: string;
}): Promise<number> {
  await startContainer({
    architecture: input.runtime.architecture,
    arguments: compactStartArguments(input.runtime, input.volume),
    containerName: input.containerName,
    environment: compactRuntimeEnvironment(),
    network: input.network,
  });
  return waitForReady(input.containerName);
}

function compactStartArguments(runtime: ImageRuntime, volume: string): string[] {
  return [
    "--volume", `${volume}:/var/lib/artifact-server`,
    runtime.image,
    "start-compact", "--data", compactDataDirectory,
    "--host", "0.0.0.0", "--port", "8787",
  ];
}

async function startExternalContainer(input: {
  readonly containerName: string;
  readonly environment: OciEnvironment;
  readonly externalEnvironment: Readonly<Record<string, string>>;
  readonly network: string;
}): Promise<number> {
  await startContainer({
    architecture: "arm64",
    arguments: [
      input.environment.arm64Image,
      "start-external-storage", "--host", "0.0.0.0", "--port", "8787",
    ],
    containerName: input.containerName,
    environment: input.externalEnvironment,
    network: input.network,
  });
  return waitForReady(input.containerName);
}

async function startContainer(input: {
  readonly architecture: Architecture;
  readonly arguments: readonly string[];
  readonly containerName: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly network: string;
}): Promise<void> {
  runtimeResources.containers.add(input.containerName);
  await docker([
    "run", "--detach",
    "--name", input.containerName,
    "--platform", `linux/${input.architecture}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
    "--network", input.network,
    "--publish", "127.0.0.1::8787",
    ...containerEnvironmentArguments(input.environment),
    ...input.arguments,
  ], input.environment);
}

function containerEnvironmentArguments(
  environment: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(environment).flatMap((name) => ["--env", name]);
}

async function waitForReady(containerName: string): Promise<number> {
  const portOutput = await docker(["port", containerName, "8787/tcp"]);
  const portMatch = /127\.0\.0\.1:(?<port>\d+)/u.exec(portOutput.stdout);
  const port = Number(portMatch?.groups?.["port"]);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Docker did not publish a valid port: ${portOutput.stdout}`);
  }
  await pollReadiness(containerName, port, 120);
  return port;
}

async function pollReadiness(
  containerName: string,
  port: number,
  attemptsRemaining: number,
): Promise<void> {
  const state = await containerState(containerName);
  if (!state.running) {
    const logs = await docker(["logs", containerName], {}, true);
    throw new Error(`Container exited before readiness: ${redact(logs.stdout + logs.stderr)}`);
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    if (response.status === 200) return;
  } catch {
    // The mapped port may accept connections after the container starts listening.
  }
  if (attemptsRemaining <= 1) {
    const logs = await docker(["logs", containerName], {}, true);
    throw new Error(`Container did not become ready: ${redact(logs.stdout + logs.stderr)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pollReadiness(containerName, port, attemptsRemaining - 1);
}

async function publishFixture(input: {
  readonly apiToken: string;
  readonly architecture?: Architecture;
  readonly containerImage: string;
  readonly kind?: "file" | "site";
  readonly network: string;
  readonly serverOrigin: string;
  readonly target?: {readonly artifactId: string; readonly expectedVersionId: string};
  readonly text: string;
}): Promise<z.infer<typeof publicationSchema>> {
  const fixtureDirectory = await temporaryDirectory("artifact-server-oci-fixture-");
  let inputPath = "/input/proof.txt";
  if (input.kind === "site") {
    inputPath = "/input";
    await mkdir(path.join(fixtureDirectory, "assets"));
    await writeFile(
      path.join(fixtureDirectory, "index.html"),
      `<main>${input.text}</main><script src="/assets/app.js"></script>`,
    );
    await writeFile(
      path.join(fixtureDirectory, "assets/app.js"),
      "document.body.dataset.release = 'ready';\n",
    );
    await chmod(path.join(fixtureDirectory, "assets"), 0o755);
  } else {
    await writeFile(path.join(fixtureDirectory, "proof.txt"), input.text);
  }
  await chmod(fixtureDirectory, 0o755);
  const environment = {ARTIFACT_SERVER_API_TOKEN: input.apiToken};
  const target = input.target === undefined
    ? ["--public"]
    : [
      "--artifact", input.target.artifactId,
      "--expected-version", input.target.expectedVersionId,
    ];
  const result = await docker([
    "run", ...hardenedRunArguments(input.architecture ?? "arm64"),
    "--network", input.network,
    "--volume", `${fixtureDirectory}:/input:ro`,
    ...containerEnvironmentArguments(environment),
    input.containerImage,
    "publish", inputPath, "--server", input.serverOrigin, ...target,
  ], environment);
  return publicationSchema.parse(JSON.parse(result.stdout));
}

function fetchContent(link: string, port: number): Promise<string> {
  const target = new URL(link);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: {host: target.host},
      host: "127.0.0.1",
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        if (incoming.statusCode !== 200) {
          reject(new Error(`Published content returned HTTP ${incoming.statusCode}.`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function boundedReadProbe(
  link: string,
  port: number,
): Promise<{readonly count: number; readonly milliseconds: number}> {
  const count = 24;
  const startedAt = performance.now();
  const responses = await Promise.all(
    Array.from({length: count}, () => fetchContent(link, port)),
  );
  const milliseconds = performance.now() - startedAt;
  expect(new Set(responses).size).toBe(1);
  expect(milliseconds).toBeLessThan(10_000);
  return {count, milliseconds};
}

async function runCompactSupportManifest(input: {
  readonly runtime: ImageRuntime;
  readonly volume: string;
}): Promise<z.infer<typeof supportManifestSchema>> {
  const runtimeEnvironment = compactRuntimeEnvironment();
  const result = await docker([
    "run", ...hardenedRunArguments(input.runtime.architecture),
    "--volume", `${input.volume}:/var/lib/artifact-server`,
    ...containerEnvironmentArguments(runtimeEnvironment),
    input.runtime.image,
    "support", "manifest", "--mode", "compact",
    "--data", "/var/lib/artifact-server/data",
  ], runtimeEnvironment);
  return supportManifestSchema.parse(JSON.parse(result.stdout));
}

async function recordRuntimeBaseline(
  kind: "compact" | "externalStorage",
  measurement: RuntimeMeasurement,
): Promise<void> {
  const outputPath = path.join(repositoryRoot, "project/evidence/oci-runtime-baseline.json");
  let current: z.infer<typeof runtimeBaselineSchema> = {};
  try {
    current = runtimeBaselineSchema.parse(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
  } catch {
    // The first result creates the evidence record.
  }
  await writeFile(outputPath, `${JSON.stringify({
    ...current,
    [kind]: measurement,
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
  }, null, 2)}\n`);
}

async function stopContainer(containerName: string): Promise<number> {
  await docker(["stop", "--time", "8", containerName]);
  const state = await containerState(containerName);
  await removeContainer(containerName);
  return state.exitCode;
}

async function containerState(
  containerName: string,
): Promise<{readonly exitCode: number; readonly running: boolean}> {
  const result = await docker([
    "inspect", "--format", "{{json .State}}", containerName,
  ]);
  const parsed = z.object({
    ExitCode: z.number().int(),
    Running: z.boolean(),
  }).parse(JSON.parse(result.stdout));
  return {exitCode: parsed.ExitCode, running: parsed.Running};
}

async function createVolume(name: string): Promise<string> {
  await docker(["volume", "create", name]);
  runtimeResources.volumes.add(name);
  return name;
}

async function createNetwork(name: string): Promise<string> {
  await docker(["network", "create", name]);
  runtimeResources.networks.add(name);
  return name;
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name], {}, true);
  runtimeResources.containers.delete(name);
}

async function removeVolume(name: string): Promise<void> {
  await docker(["volume", "rm", "--force", name], {}, true);
  runtimeResources.volumes.delete(name);
}

async function removeNetwork(name: string): Promise<void> {
  await docker(["network", "rm", name], {}, true);
  runtimeResources.networks.delete(name);
}

function resourceSuffix(): string {
  return `${process.pid}-${randomBytes(5).toString("hex")}`;
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function docker(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  allowFailure = false,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile("docker", arguments_, {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null && !allowFailure) {
        reject(new Error(`Docker command failed: ${redact(stderr || stdout)}`));
        return;
      }
      const failure = commandFailureSchema.safeParse(error);
      const exitCode = error === null ? 0 : failure.success ? failure.data.code : 1;
      resolve({exitCode, stderr, stdout});
    });
  });
}

function redact(value: string): string {
  let redacted = value.replaceAll(
    /postgres(?:ql)?:\/\/[^\s]+/gu,
    "[REDACTED_DATABASE_URL]",
  );
  for (const sensitive of sensitiveValues) {
    redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted;
}

function registerSensitiveValue(value: string): void {
  if (value.length > 0) sensitiveValues.add(value);
}
