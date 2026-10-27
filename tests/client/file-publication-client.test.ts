import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {fetchLoopbackContent} from "../support/fetch-loopback-content.js";

import {
  type FilePublicationCommand,
  type FilePublicationFailure,
  type FilePublicationResult,
  mediaTypeForPath,
  publishPath,
} from "../../src/client/file-publication-client.js";
import {
  createTestInstallation,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

interface ClientSuccess {
  readonly result: FilePublicationResult;
  readonly success: true;
}

interface ClientFailure {
  readonly error: FilePublicationFailure;
  readonly success: false;
}

type ClientOutcome = ClientFailure | ClientSuccess;
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const savedVersionSchema = z.object({
  manifest: z.object({entries: z.array(z.object({path: z.string()}))}),
});

describe("file publication client", () => {
  let fixtureDirectory: string;
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeAll(async () => {
    installation = await createTestInstallation();
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-client-"));
    server = await startTestServer(installation);
  });

  afterAll(async () => {
    await server.stop();
    await Promise.all([
      removeTestInstallation(installation),
      rm(fixtureDirectory, {force: true, recursive: true}),
    ]);
  });

  test("publishes an ordinary file, a complete directory, and an optimistic new version", async () => {
    const reportPath = path.join(fixtureDirectory, "report.pdf");
    const firstReport = Buffer.from("%PDF-1.4\nfirst client version\n%%EOF\n");
    await writeFile(reportPath, firstReport);

    const report = await executeClient(
      server.baseUrl,
      installation.apiToken,
      newArtifactCommand(reportPath, "public_link"),
    );
    expect(report.success).toBe(true);
    if (!report.success) return;
    expect(report.result.artifact).toMatchObject({
      accessSetting: "public_link",
      name: "report.pdf",
      tags: ["client-test"],
    });
    const openedReport = await fetchLoopbackContent(report.result.links.version);
    expect(openedReport.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await openedReport.arrayBuffer())).toEqual(firstReport);

    const sitePath = path.join(fixtureDirectory, "site");
    await mkdir(path.join(sitePath, "assets"), {recursive: true});
    await Promise.all([
      writeFile(path.join(sitePath, "home.html"), "<h1>Complete client site</h1>"),
      writeFile(path.join(sitePath, "assets/app.js"), "document.body.dataset.ready = 'yes';"),
    ]);
    const site = await executeClient(
      server.baseUrl,
      installation.apiToken,
      {
        ...newArtifactCommand(sitePath, "account_required"),
        entryPath: "home.html",
      },
    );
    expect(site.success).toBe(true);
    if (!site.success) return;
    expect(site.result.version.entryPath).toBe("home.html");

    const secondReport = Buffer.from("%PDF-1.4\nsecond client version\n%%EOF\n");
    await writeFile(reportPath, secondReport);
    const version = await executeClient(
      server.baseUrl,
      installation.apiToken,
      {
        idempotencyKey: randomUUID(),
        inputPath: reportPath,
        target: {
          artifactId: report.result.artifact.id,
          expectedCurrentVersionId: report.result.version.id,
          kind: "new_version",
        },
      },
    );
    expect(version.success).toBe(true);
    if (!version.success) return;
    expect(version.result.version).toMatchObject({number: 2});
    const openedVersion = await fetchLoopbackContent(version.result.links.version);
    expect(Buffer.from(await openedVersion.arrayBuffer())).toEqual(secondReport);
  });

  test("MAN-004-B: publishes a directory of regular files and nested directories", async () => {
    const sitePath = path.join(fixtureDirectory, "regular-tree");
    await mkdir(path.join(sitePath, "assets/images"), {recursive: true});
    await mkdir(path.join(sitePath, "empty"));
    const contents = new Map([
      ["assets/app.js", "document.body.dataset.tree = 'regular';"],
      ["assets/images/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
      ["index.html", "<h1>Regular tree</h1>"],
    ]);
    await Promise.all([...contents].map(([filePath, body]) =>
      writeFile(path.join(sitePath, filePath), body)
    ));

    const published = await executeClient(
      server.baseUrl,
      installation.apiToken,
      newArtifactCommand(sitePath, "public_link"),
    );
    expect(published.success).toBe(true);
    if (!published.success) return;

    const versionResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.result.artifact.id}/versions/${published.result.version.id}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(versionResponse.status).toBe(200);
    const saved = savedVersionSchema.parse(await versionResponse.json());
    expect(saved.manifest.entries.map((entry) => entry.path)).toEqual([...contents.keys()]);
    const served = await Promise.all([...contents.keys()].map(async (filePath) =>
      (await fetchLoopbackContent(new URL(`/${filePath}`, published.result.links.version))).text()
    ));
    expect(served).toEqual([...contents.values()]);
  });

  test("MAN-004-F: rejects every special filesystem entry before the server sees an upload", {timeout: 30_000}, async () => {
    const specialRoot = await mkdtemp(path.join("/tmp", "artifact-server-special-"));
    const socketServers: Server[] = [];
    const recorder = await startRecordingServer();
    try {
      const target = path.join(specialRoot, "target.html");
      await writeFile(target, "<h1>Link target</h1>");
      const listenAt = async (socketPath: string): Promise<void> => {
        const socketServer = createServer();
        socketServers.push(socketServer);
        await new Promise<void>((resolve, reject) => {
          socketServer.once("error", reject);
          socketServer.listen(socketPath, resolve);
        });
      };
      const directoryWith = async (
        name: string,
        create: (entryPath: string) => Promise<void>,
      ): Promise<string> => {
        const directory = path.join(specialRoot, name);
        await mkdir(directory);
        await writeFile(path.join(directory, "index.html"), "<h1>Regular file</h1>");
        await create(path.join(directory, "special"));
        return directory;
      };
      const rootEntry = async (
        name: string,
        create: (entryPath: string) => Promise<void>,
      ): Promise<string> => {
        const entryPath = path.join(specialRoot, name);
        await create(entryPath);
        return entryPath;
      };
      const cases: readonly (readonly [string, string])[] = [
        [await directoryWith("file-link", (entry) => symlink(target, entry)), "symbolic_link"],
        [await directoryWith("directory-link", (entry) => symlink(specialRoot, entry)), "symbolic_link"],
        [await directoryWith("fifo", makeFifo), "unsupported_file_type"],
        [await directoryWith("socket", listenAt), "unsupported_file_type"],
        [await rootEntry("root-link.html", (entry) => symlink(target, entry)), "symbolic_link"],
        [await rootEntry("root-fifo", makeFifo), "unsupported_file_type"],
        [await rootEntry("root.sock", listenAt), "unsupported_file_type"],
        ["/dev/null", "unsupported_file_type"],
        [await firstBlockDevice(), "unsupported_file_type"],
      ];

      const outcomes = await Promise.all(cases.map(([inputPath]) =>
        executeClient(recorder.origin, installation.apiToken, newArtifactCommand(inputPath))
      ));
      expect(outcomes.map((outcome, index) => [cases[index]?.[0], failureReason(outcome)]))
        .toEqual(cases);
      expect(recorder.requests()).toBe(0);
    } finally {
      await Promise.all(socketServers.map(closeServer));
      await closeServer(recorder.server);
      await rm(specialRoot, {force: true, recursive: true});
    }
  });

  test("classifies unsafe filesystem inputs before it creates an upload", async () => {
    const emptyPath = path.join(fixtureDirectory, "empty");
    const missingEntryPath = path.join(fixtureDirectory, "missing-entry");
    const unsafePath = path.join(fixtureDirectory, "unsafe");
    await Promise.all([
      mkdir(emptyPath),
      mkdir(missingEntryPath),
      mkdir(path.join(unsafePath, ".git"), {recursive: true}),
    ]);
    await Promise.all([
      writeFile(path.join(missingEntryPath, "page.html"), "<h1>Wrong entry</h1>"),
      writeFile(path.join(unsafePath, ".git/config"), "[core]\n"),
    ]);

    const [empty, missingEntry, unsafe] = await Promise.all([
      executeClient(server.baseUrl, installation.apiToken, newArtifactCommand(emptyPath)),
      executeClient(
        server.baseUrl,
        installation.apiToken,
        newArtifactCommand(missingEntryPath),
      ),
      executeClient(server.baseUrl, installation.apiToken, newArtifactCommand(unsafePath)),
    ]);
    expect(failureReason(empty)).toBe("empty_directory");
    expect(failureReason(missingEntry)).toBe("invalid_entry");
    expect(failureReason(unsafe)).toBe("invalid_path");
  });

  test("fails closed for invalid credentials, invalid server origins, and cross-origin upload plans", async () => {
    const filePath = path.join(fixtureDirectory, "safe.txt");
    await writeFile(filePath, "safe publication input");

    const unauthorized = await executeClient(
      server.baseUrl,
      "invalid-credential-with-sufficient-entropy",
      newArtifactCommand(filePath),
    );
    expect(unauthorized).toMatchObject({
      error: {
        _tag: "FilePublicationProtocolError",
        operation: "create_upload",
        serverCode: "AUTHENTICATION_REQUIRED",
        status: 401,
      },
      success: false,
    });

    const invalidOrigin = await executeClient(
      "https://username:password@example.test",
      installation.apiToken,
      newArtifactCommand(filePath),
    );
    expect(invalidOrigin).toMatchObject({
      error: {
        _tag: "FilePublicationConfigurationError",
        reason: "invalid_server",
      },
      success: false,
    });

    const uploadPlanServer = await startUnsafeUploadPlanServer();
    try {
      const unsafePlan = await executeClient(
        uploadPlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(unsafePlan).toMatchObject({
        error: {
          _tag: "FilePublicationConfigurationError",
          reason: "unsafe_upload_plan",
        },
        success: false,
      });
    } finally {
      await closeServer(uploadPlanServer.server);
    }
  });

  test("rejects incomplete and malformed plans and reports an unavailable server as protocol failures", async () => {
    const filePath = path.join(fixtureDirectory, "protocol.txt");
    await writeFile(filePath, "protocol failure fixture");

    const incompletePlanServer = await startResponseServer((origin) => JSON.stringify({
      commitUrl: `${origin}/commit`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      files: [],
      manifestDigest: "0".repeat(64),
      projectId: "prj_default",
      uploadId: "incomplete-upload-plan",
    }));
    try {
      const incomplete = await executeClient(
        incompletePlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(incomplete).toMatchObject({
        error: {
          _tag: "FilePublicationConfigurationError",
          reason: "unsafe_upload_plan",
        },
        success: false,
      });
    } finally {
      await closeServer(incompletePlanServer.server);
    }

    const malformedPlanServer = await startResponseServer(() => "{}");
    try {
      const malformed = await executeClient(
        malformedPlanServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(malformed).toMatchObject({
        error: {
          _tag: "FilePublicationProtocolError",
          operation: "create_upload",
          status: 201,
        },
        success: false,
      });
    } finally {
      await closeServer(malformedPlanServer.server);
    }

    const unavailableServer = await startResponseServer(() => "{}");
    await closeServer(unavailableServer.server);
    const unavailable = await executeClient(
      unavailableServer.origin,
      installation.apiToken,
      newArtifactCommand(filePath),
    );
    expect(unavailable).toMatchObject({
      error: {
        _tag: "FilePublicationProtocolError",
        operation: "create_upload",
        serverCode: null,
        status: null,
      },
      success: false,
    });

    const unstructuredFailureServer = await startResponseServer(
      () => "not a JSON error",
      500,
    );
    try {
      const unstructured = await executeClient(
        unstructuredFailureServer.origin,
        installation.apiToken,
        newArtifactCommand(filePath),
      );
      expect(unstructured).toMatchObject({
        error: {
          _tag: "FilePublicationProtocolError",
          operation: "create_upload",
          serverCode: null,
          status: 500,
        },
        success: false,
      });
    } finally {
      await closeServer(unstructuredFailureServer.server);
    }
  });

  test("uses deterministic media types and a safe binary fallback", () => {
    expect([
      mediaTypeForPath("index.HTML"),
      mediaTypeForPath("document.pdf"),
      mediaTypeForPath("movie.mp4"),
      mediaTypeForPath("unknown.custom"),
    ]).toEqual([
      "text/html; charset=utf-8",
      "application/pdf",
      "video/mp4",
      "application/octet-stream",
    ]);
  });
});

function newArtifactCommand(
  inputPath: string,
  accessSetting: "account_required" | "public_link" = "account_required",
): FilePublicationCommand {
  return {
    idempotencyKey: randomUUID(),
    inputPath,
    target: {
      accessSetting,
      kind: "new_artifact",
      tags: ["client-test"],
    },
  };
}

function executeClient(
  serverOrigin: string,
  apiToken: string,
  command: FilePublicationCommand,
): Promise<ClientOutcome> {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: Redacted.make(apiToken, {label: "test-api-token"}),
        serverOrigin,
      },
      command,
    ).pipe(
      Effect.match({
        onFailure: (error): ClientFailure => ({error, success: false}),
        onSuccess: (result): ClientSuccess => ({result, success: true}),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function failureReason(outcome: ClientOutcome): string | undefined {
  return outcome.success ? undefined : "reason" in outcome.error
    ? outcome.error.reason
    : undefined;
}

async function startUnsafeUploadPlanServer(): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  return startResponseServer(() => JSON.stringify({
      commitUrl: "https://elsewhere.example.test/commit",
      expiresAt: "2099-01-01T00:00:00.000Z",
      files: [{
        method: "PUT",
        path: "safe.txt",
        size: 22,
        uploadUrl: "https://elsewhere.example.test/upload",
      }],
      manifestDigest: "0".repeat(64),
      projectId: "prj_default",
      uploadId: "unsafe-upload-plan",
    }));
}

async function startResponseServer(
  responseForOrigin: (origin: string) => string,
  status = 201,
): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  let origin = "";
  const server = createServer((_request, response) => {
    response.writeHead(status, {"Content-Type": "application/json"});
    response.end(responseForOrigin(origin));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = assignedAddressSchema.safeParse(server.address());
  if (!address.success) {
    await closeServer(server);
    throw new Error("The unsafe upload-plan test server did not receive a TCP port.");
  }
  origin = `http://127.0.0.1:${address.data.port}`;
  return {origin, server};
}

async function startRecordingServer(): Promise<{
  readonly origin: string;
  readonly requests: () => number;
  readonly server: Server;
}> {
  let requests = 0;
  const recorder = await startResponseServer(() => {
    requests += 1;
    return "{}";
  }, 500);
  return {...recorder, requests: () => requests};
}

function makeFifo(fifoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("mkfifo", [fifoPath], (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function firstBlockDevice(): Promise<string> {
  const names = await readdir("/dev");
  const candidates = await Promise.all(names.map(async (name) => {
    const devicePath = path.join("/dev", name);
    const info = await lstat(devicePath).catch(() => null);
    return info?.isBlockDevice() === true ? devicePath : null;
  }));
  const device = candidates.find((candidate) => candidate !== null);
  if (device === undefined || device === null) {
    throw new Error("MAN-004-F needs one block device under /dev to prove block devices are rejected.");
  }
  return device;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
