import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {z} from "zod";

import {
  type LocalServerConfig,
  startLocalServer,
} from "../../src/local/start-local-server.js";
import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import type {AssetQuota} from "../../src/core/asset-policy.js";
import type {Clock} from "../../src/core/ports.js";
import type {ViewerLogo} from "../../src/core/viewer-logo.js";
import {localOwnerBrowserAccess} from "../../src/core/browser-access.js";
import type {BrowserAccess} from "../../src/core/browser-access.js";
import {defaultCompletedRequestLogSampleRate} from
  "../../src/observability/application-observability.js";
import type {ArtifactViewCollectionPolicy} from
  "../../src/lifecycle/artifact-view-collection.js";

const assignedAddressSchema = z.object({port: z.number().int().positive()});

export interface TestInstallation {
  readonly apiToken: string;
  readonly browserBootstrapToken: string;
  readonly dataDirectory: string;
}

export interface RunningTestServer {
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  /** Write buffered entry-document view counts now, without waiting for a drain. */
  flushArtifactViews(): Promise<void>;
  stop(): Promise<void>;
}

/** Reserve one free loopback port so a caller can bind it deliberately. */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.parse(server.address());
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}

export async function createTestInstallation(): Promise<TestInstallation> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-test-"),
  );
  return {
    apiToken:
      "as_key_key_00000000-0000-4000-8000-000000000001_testLocalApiTokenWithSufficientEntropy123",
    browserBootstrapToken: "test-local-browser-token-with-sufficient-entropy",
    dataDirectory,
  };
}

export async function removeTestInstallation(
  installation: TestInstallation,
): Promise<void> {
  await rm(installation.dataDirectory, {force: true, recursive: true});
}

export async function startTestServer(
  installation: TestInstallation,
  options: {
    readonly applicationOrigin?: string;
    readonly artifactViewCollectionPolicy?: ArtifactViewCollectionPolicy;
    readonly assetQuota?: AssetQuota;
    readonly bootstrapAdministratorEmail?: string;
    readonly browserAccess?: BrowserAccess;
    readonly contentDomain?: string | null;
    readonly clock?: Clock;
    readonly completedRequestLogSampleRate?: number;
    readonly developmentProxyCredential?: string;
    readonly externalApiBearerVerifier?: BearerCredentialVerifier;
    readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
    readonly helpUrl?: string;
    readonly hostname?: string;
    readonly logo?: ViewerLogo;
    readonly observability?: boolean;
    readonly port?: number;
    readonly webAssetsRoot?: string;
  } = {},
): Promise<RunningTestServer> {
  const baseConfig: LocalServerConfig = {
    apiToken: installation.apiToken,
    browserAccess: options.browserAccess ?? localOwnerBrowserAccess,
    bootstrapAdministratorEmail: options.bootstrapAdministratorEmail ??
      "administrator@example.test",
    contentDomain: options.contentDomain === undefined
      ? "localhost"
      : options.contentDomain,
    completedRequestLogSampleRate:
      options.completedRequestLogSampleRate ??
        defaultCompletedRequestLogSampleRate,
    dataDirectory: installation.dataDirectory,
    localBootstrapToken: installation.browserBootstrapToken,
    observability: options.observability ?? false,
    port: options.port ?? 0,
  };
  let config: LocalServerConfig = baseConfig;
  if (options.applicationOrigin !== undefined) {
    config = {...config, applicationOrigin: options.applicationOrigin};
  }
  if (options.artifactViewCollectionPolicy !== undefined) {
    config = {
      ...config,
      artifactViewCollectionPolicy: options.artifactViewCollectionPolicy,
    };
  }
  if (options.assetQuota !== undefined) {
    config = {...config, assetQuota: options.assetQuota};
  }
  if (options.clock !== undefined) {
    config = {...config, clock: options.clock};
  }
  if (options.externalApiBearerVerifier !== undefined) {
    config = {
      ...config,
      externalApiBearerVerifier: options.externalApiBearerVerifier,
    };
  }
  if (options.developmentProxyCredential !== undefined) {
    config = {
      ...config,
      developmentProxyCredential: options.developmentProxyCredential,
    };
  }
  if (options.externalMcpBearerVerifier !== undefined) {
    config = {
      ...config,
      externalMcpBearerVerifier: options.externalMcpBearerVerifier,
    };
  }
  if (options.helpUrl !== undefined) {
    config = {...config, helpUrl: options.helpUrl};
  }
  if (options.hostname !== undefined) {
    config = {...config, hostname: options.hostname};
  }
  if (options.logo !== undefined) {
    config = {...config, logo: options.logo};
  }
  if (options.webAssetsRoot !== undefined) {
    config = {...config, webAssetsRoot: options.webAssetsRoot};
  }
  const server = await startLocalServer(config);

  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    flushArtifactViews: async () => {
      await server.flushArtifactViews();
    },
    hostname: server.hostname,
    port: server.port,
    stop: () => server.close(),
  };
}

/** Exchange the stable test-only credential for one browser login token. */
export async function issueLocalBrowserLogin(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<string> {
  const response = await fetch(new URL("/auth/local", server.baseUrl), {
    headers: {
      Authorization: `Bearer ${installation.browserBootstrapToken}`,
    },
    method: "POST",
  });
  if (response.status !== 201) {
    throw new Error(`Local browser login issuance failed with ${response.status}.`);
  }
  return z.object({
    expiresAt: z.iso.datetime(),
    token: z.string().min(32).max(200),
  }).strict().parse(await response.json()).token;
}

export async function fetchVersion(
  server: RunningTestServer,
  versionUrl: string,
  method = "GET",
  headers?: HeadersInit,
): Promise<Response> {
  const target = new URL(versionUrl);
  const requestHeaders = ["Host", `${target.hostname}:${server.port}`];
  for (const [name, value] of new Headers(headers)) {
    requestHeaders.push(name, value);
  }
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        headers: requestHeaders,
        hostname: "127.0.0.1",
        method,
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              responseHeaders.append(name, value);
            }
          }
          const bytes = Buffer.concat(chunks);
          const body = new Uint8Array(bytes.byteLength);
          body.set(bytes);
          const status = incoming.statusCode ?? 500;
          resolve(
            new Response(status === 204 || status === 205 || status === 304
              ? null
              : body.buffer, {
              headers: responseHeaders,
              status,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export function apiHeaders(
  installation: TestInstallation,
  idempotencyKey: string,
): Headers {
  return new Headers({
    Authorization: `Bearer ${installation.apiToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
}
