import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import type { ApplicationRuntime } from "../application/application-runtime.js";
import type { BearerCredentialVerifier } from "../application/authentication.js";
import {
  InstallationAccessService,
  type IssueOperatorKeyCommand,
  type IssuedOperatorKey,
} from "../application/installation-access.js";
import {type AssetQuota, defaultAssetQuota} from "../core/asset-policy.js";
import type { Clock } from "../core/ports.js";
import type {BrowserAccess} from "../core/browser-access.js";
import type {ViewerLogo} from "../core/viewer-logo.js";
import { SystemClock, SystemIdGenerator } from "../core/system.js";
import { createHttpApp } from "../http/create-http-app.js";
import type { HttpAppDependencies } from "../http/create-http-app.js";
import {
  defaultCompletedRequestLogSampleRate,
  otlpLayer,
  silentLoggingLayer,
  structuredLoggingLayer,
} from "../observability/application-observability.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";
import { LocalStagingStore } from "../storage/local-staging-store.js";
import { SqliteArtifactRepository } from "../storage/sqlite-artifact-repository.js";
import { SqliteIdentityRepository } from "../storage/sqlite-identity-repository.js";
import { createLocalApplicationLayer } from "./create-local-application-layer.js";
import type {RuntimeLifecycle} from "../lifecycle/runtime-readiness.js";
import {
  defaultStagingCleanupPolicy,
  runStagingCleanupPass,
  startStagingCleanupSchedule,
  type StagingCleanupPolicy,
} from "../lifecycle/staging-cleanup.js";
import type {ExpiredStagingCleanupReport} from
  "../application/expired-staging-cleanup.js";
import {createNodeWebAssetStore} from "../http/node-web-assets.js";
import {browserAccessModes} from "../core/browser-access.js";
import {ensureBootstrapManagedApiKey} from
  "../application/bootstrap-managed-api-key.js";
import {
  type ArtifactViewDrainReport,
  createArtifactViewRecorder,
  defaultArtifactViewDrainChunkSize,
} from "../application/artifact-view-recorder.js";
import {
  type ArtifactViewCollectionPolicy,
  defaultArtifactViewCollectionPolicy,
  startArtifactViewCollection,
} from "../lifecycle/artifact-view-collection.js";

export interface LocalRuntimeConfig {
  readonly apiToken: string;
  readonly applicationOrigin?: string;
  /** Drain cadence for entry-document view counts; tests use a fast value. */
  readonly artifactViewCollectionPolicy?: ArtifactViewCollectionPolicy;
  /** Per-artifact asset quota; the default applies when it is omitted. */
  readonly assetQuota?: AssetQuota;
  readonly bootstrapAdministratorEmail?: string;
  readonly browserAccess: BrowserAccess;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string | null;
  readonly dataDirectory: string;
  /** Server-only credential shared with a co-launched development proxy. */
  readonly developmentProxyCredential?: string;
  readonly externalApiBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
  readonly localBootstrapToken?: string;
  /** The account menu's Help link; absent or null shows no Help item. */
  readonly helpUrl?: string | null;
  /** The viewer bar's logo; absent or null shows the product mark. */
  readonly logo?: ViewerLogo | null;
  readonly observability?: boolean;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly installationId?: string;
  readonly serviceVersion?: string;
  readonly stagingCleanupPolicy?: StagingCleanupPolicy;
  /** Overrides the compiled web bundle directory; used by tests. */
  readonly webAssetsRoot?: string;
}

export interface LocalRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  /** Write buffered view counts now instead of waiting for the next drain. */
  flushArtifactViews(): Promise<ArtifactViewDrainReport>;
  cleanupStaging(limit: number): Promise<ExpiredStagingCleanupReport>;
  issueOperatorKey(
    command: IssueOperatorKeyCommand,
  ): Promise<IssuedOperatorKey>;
  close(): Promise<void>;
}

export async function createLocalRuntime(
  config: LocalRuntimeConfig,
): Promise<LocalRuntime> {
  await mkdir(config.dataDirectory, {recursive: true, mode: 0o700});
  const blobs = new LocalBlobStore(path.join(config.dataDirectory, "blobs"));
  const staging = new LocalStagingStore(path.join(config.dataDirectory, "staging"));
  const databasePath = path.join(config.dataDirectory, "artifact-server.db");
  const installationId = config.installationId ?? "local";
  const runtimeClock = config.clock ?? new SystemClock();
  const stagingCleanupPolicy = config.stagingCleanupPolicy ??
    defaultStagingCleanupPolicy;
  const repository = new SqliteArtifactRepository(databasePath, installationId);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const artifactViewRecorder = createArtifactViewRecorder({
    chunkSize: defaultArtifactViewDrainChunkSize,
    clock: runtimeClock,
    repository,
  });
  const apiToken = Redacted.make(config.apiToken, {label: "local-api-token"});
  if (config.browserAccess.mode === browserAccessModes.privateTeam) {
    try {
      await ensureBootstrapManagedApiKey({
        credential: apiToken,
        installationId,
        now: runtimeClock.now(),
        repository: identityRepository,
      });
    } catch (cause) {
      identityRepository.close();
      repository.close();
      throw cause;
    }
  }
  const resourceLayer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.succeed({identityRepository, repository}),
      (owned) => Effect.sync(() => {
        owned.identityRepository.close();
        owned.repository.close();
      }),
    ),
  );
  const applicationAdapters: Parameters<typeof createLocalApplicationLayer>[0] = {
    apiToken: config.browserAccess.mode === browserAccessModes.localOwner
      ? apiToken
      : null,
    assetQuota: config.assetQuota ?? defaultAssetQuota,
    blobs,
    bootstrapAdministratorEmail: config.bootstrapAdministratorEmail ??
      "local-administrator@artifactserver.invalid",
    clock: runtimeClock,
    dispatches: repository,
    externalApiBearerVerifier: config.externalApiBearerVerifier ?? null,
    externalMcpBearerVerifier: config.externalMcpBearerVerifier ?? null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId,
    localBootstrapCredential: config.localBootstrapToken === undefined
      ? null
      : Redacted.make(config.localBootstrapToken, {
        label: "local-browser-bootstrap",
      }),
    protectBootstrapAdministrator:
      config.browserAccess.mode === browserAccessModes.localOwner,
    repository,
    staging,
    stagingCleanupPolicy,
  };
  const applicationLayer = createLocalApplicationLayer(applicationAdapters);
  const telemetryLayer = config.observability === true
    ? otlpLayer({
      deploymentMode: "local",
      installationId,
      serviceVersion: config.serviceVersion ?? "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer))
    : silentLoggingLayer;
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, resourceLayer, telemetryLayer),
  );
  try {
    await applicationRuntime.context();
    let appDependencies: HttpAppDependencies = {
      applicationRuntime,
      artifactViews: artifactViewRecorder,
      blobs,
      browserAccess: config.browserAccess,
      clock: runtimeClock,
      completedRequestLogSampleRate:
        config.completedRequestLogSampleRate ??
          defaultCompletedRequestLogSampleRate,
      contentDomain: config.contentDomain,
      helpUrl: config.helpUrl ?? null,
      logo: config.logo ?? null,
      trustedApplicationOrigin: config.applicationOrigin ?? null,
      webAssets: createNodeWebAssetStore(config.webAssetsRoot),
    };
    if (config.developmentProxyCredential !== undefined) {
      appDependencies = {
        ...appDependencies,
        developmentProxyCredential: Redacted.make(
          config.developmentProxyCredential,
          {label: "development-proxy"},
        ),
      };
    }
    const app = createHttpApp(config.runtimeLifecycle === undefined
      ? appDependencies
      : {...appDependencies, runtimeLifecycle: config.runtimeLifecycle});

    const closeCleanupSchedule = stagingCleanupPolicy.schedule === "background"
      ? startStagingCleanupSchedule(applicationRuntime, stagingCleanupPolicy)
      : null;
    const closeArtifactViewCollection = startArtifactViewCollection(
      applicationRuntime,
      artifactViewRecorder,
      config.artifactViewCollectionPolicy ??
        defaultArtifactViewCollectionPolicy,
    );
    return {
      app,
      cleanupStaging: (limit) => runStagingCleanupPass(applicationRuntime, limit),
      issueOperatorKey: (command) => applicationRuntime.runPromise(
        InstallationAccessService.use((access) =>
          access.issueOperatorKey(command)
        ),
      ),
      flushArtifactViews: () => artifactViewRecorder.flush(),
      close: async () => {
        if (closeCleanupSchedule !== null) await closeCleanupSchedule();
        // Drains what is buffered before the repository closes, so a clean
        // shutdown loses no counted view.
        await closeArtifactViewCollection();
        await applicationRuntime.dispose();
      },
    };
  } catch (error) {
    await applicationRuntime.dispose();
    throw error;
  }
}
