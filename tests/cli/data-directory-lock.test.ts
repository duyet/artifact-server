import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories = new Set<string>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const serviceRecordSchema = z.object({origin: z.url(), pid: z.number().int()});
const lockRefusal = "Another Artifact Server process is already serving";
const compactEnvironment = {
  ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
  ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
  ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "2000",
};

afterEach(async () => {
  await Promise.all([...runningProcesses].map(async (child) => {
    runningProcesses.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = processExit(child);
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, {force: true, recursive: true})
  ));
  temporaryDirectories.clear();
});

describe("one server per data directory", () => {
  test("start-compact refuses a second server, keeps the first serving, and recovers after a crash", async () => {
    const parent = await temporaryDirectory();
    const dataDirectory = path.join(parent, "data");
    const initialized = await runCli([
      "init", "--admin-email", "admin@example.test", "--data", dataDirectory,
    ]);
    expect(initialized.exitCode).toBe(0);

    const firstPort = await availablePort();
    const first = startCli(compactStart(dataDirectory, firstPort), compactEnvironment);
    await waitForOutput(first, '"status":"ready"');
    const entriesBeforeRefusal = await readdir(dataDirectory);

    const secondPort = await availablePort();
    const second = await runCli(
      compactStart(dataDirectory, secondPort),
      compactEnvironment,
    );
    expect(second.exitCode).not.toBe(0);
    expect(second.output).toContain(lockRefusal);
    expect(await isReady(secondPort)).toBe(false);
    expect(await readdir(dataDirectory)).toEqual(entriesBeforeRefusal);
    expect(await isReady(firstPort)).toBe(true);

    const readOnlyCommands = [
      ["integrity", "check", "--mode", "compact", "--data", dataDirectory],
      ["config", "check", "--mode", "compact", "--data", dataDirectory],
      ["support", "manifest", "--mode", "compact", "--data", dataDirectory],
    ];
    const readOnlyResults = await Promise.all(readOnlyCommands.map(async (command) =>
      ({command: command.join(" "), exitCode: (await runCli(command, compactEnvironment)).exitCode})
    ));
    expect(readOnlyResults).toEqual(readOnlyCommands.map((command) =>
      ({command: command.join(" "), exitCode: 0})
    ));
    expect(await isReady(firstPort)).toBe(true);

    await killAndWait(first, "SIGKILL");
    const afterCrash = startCli(compactStart(dataDirectory, secondPort), compactEnvironment);
    await waitForOutput(afterCrash, '"status":"ready"');
    expect(await isReady(secondPort)).toBe(true);

    await killAndWait(afterCrash, "SIGTERM");
    expect(afterCrash.exitCode).toBe(0);
    const afterStop = startCli(compactStart(dataDirectory, firstPort), compactEnvironment);
    await waitForOutput(afterStop, '"status":"ready"');
    expect(await isReady(firstPort)).toBe(true);
  }, 60_000);

  test("direct local start refuses a second server without touching its credentials or service record", async () => {
    const parent = await temporaryDirectory();
    const dataDirectory = path.join(parent, "data");
    const localStart = ["start", "--managed", "--port", "0", "--data", dataDirectory];

    const first = startCli(localStart, {ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0"});
    await waitForOutput(first, "Data directory:");
    await waitForServiceRecord(dataDirectory, first.pid);
    const recordBefore = await readFile(path.join(dataDirectory, "local-service.json"), "utf8");
    const record = serviceRecordSchema.parse(JSON.parse(recordBefore));
    const credentialBefore = await readFile(
      path.join(dataDirectory, "local-api-token"),
      "utf8",
    );

    const second = await runCli(localStart, {ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0"});
    expect(second.exitCode).not.toBe(0);
    expect(second.output).toContain(lockRefusal);
    expect(await readFile(path.join(dataDirectory, "local-service.json"), "utf8"))
      .toBe(recordBefore);
    expect(await readFile(path.join(dataDirectory, "local-api-token"), "utf8"))
      .toBe(credentialBefore);
    expect((await fetch(new URL("/health", record.origin))).status).toBe(200);

    await killAndWait(first, "SIGKILL");
    const afterCrash = startCli(localStart, {ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0"});
    await waitForOutput(afterCrash, "Data directory:");
    const recovered = serviceRecordSchema.parse(JSON.parse(
      await waitForServiceRecord(dataDirectory, afterCrash.pid),
    ));
    expect((await fetch(new URL("/health", recovered.origin))).status).toBe(200);
  }, 60_000);

  test("open names the server that already holds the directory instead of waiting for a start that can only fail", async () => {
    const parent = await temporaryDirectory();
    const dataDirectory = path.join(parent, "data");
    const initialized = await runCli([
      "init", "--admin-email", "admin@example.test", "--data", dataDirectory,
    ]);
    expect(initialized.exitCode).toBe(0);
    const port = await availablePort();
    const holder = startCli(compactStart(dataDirectory, port), compactEnvironment);
    await waitForOutput(holder, '"status":"ready"');

    const startedAt = Date.now();
    const opened = await runCli(["open", "--data", dataDirectory], {
      ARTIFACT_SERVER_BROWSER_COMMAND: "/bin/true",
    });
    expect(opened.exitCode).not.toBe(0);
    expect(opened.output).toContain(lockRefusal);
    // The managed start would have waited out its 15 second health timeout.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await isReady(port)).toBe(true);
  }, 60_000);
});

describe("a maintenance command alongside a running server", () => {
  test("upgrades an older compact database only after the server that holds it stops", async () => {
    const parent = await temporaryDirectory();
    const dataDirectory = path.join(parent, "data");
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    expect((await runCli([
      "init", "--admin-email", "admin@example.test", "--data", dataDirectory,
    ])).exitCode).toBe(0);
    const issueKey = (name: string) => runCli([
      "admin", "issue-key", "--email", `${name}@example.test`, "--name", name,
      "--data", dataDirectory,
    ], compactEnvironment);
    expect((await issueKey("before-start")).exitCode).toBe(0);
    expect(schemaVersion(databasePath)).toBe(requiredSqliteSchemaVersion);

    const port = await availablePort();
    const server = startCli(compactStart(dataDirectory, port), compactEnvironment);
    await waitForOutput(server, '"status":"ready"');

    const alongsideCurrent = await issueKey("alongside");
    expect(alongsideCurrent.exitCode).toBe(0);
    expect(await isReady(port)).toBe(true);

    const olderSchemaVersion = requiredSqliteSchemaVersion - 1;
    withDatabase(databasePath, (database) =>
      database.exec(`PRAGMA user_version = ${olderSchemaVersion}`)
    );
    const keysBeforeRefusal = managedKeyCount(databasePath);

    const refused = await issueKey("refused");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.output).toContain(
      `A running Artifact Server is using ${dataDirectory} with an older schema. Stop it before running this newer command; nothing was changed.`,
    );
    expect(schemaVersion(databasePath)).toBe(olderSchemaVersion);
    expect(managedKeyCount(databasePath)).toBe(keysBeforeRefusal);

    const readOnlyCommands = [
      ["integrity", "check", "--mode", "compact", "--data", dataDirectory],
      ["config", "check", "--mode", "compact", "--data", dataDirectory],
      ["support", "manifest", "--mode", "compact", "--data", dataDirectory],
    ];
    const readOnlyResults = await Promise.all(readOnlyCommands.map(async (command) =>
      ({command: command.join(" "), exitCode: (await runCli(command, compactEnvironment)).exitCode})
    ));
    expect(readOnlyResults).toEqual(readOnlyCommands.map((command) =>
      ({command: command.join(" "), exitCode: 0})
    ));
    expect(schemaVersion(databasePath)).toBe(olderSchemaVersion);
    expect(await isReady(port)).toBe(true);

    await killAndWait(server, "SIGTERM");
    const afterStop = await issueKey("after-stop");
    expect(afterStop.exitCode).toBe(0);
    expect(schemaVersion(databasePath)).toBe(requiredSqliteSchemaVersion);
    expect(managedKeyCount(databasePath)).toBe(keysBeforeRefusal + 1);
  }, 60_000);
});

function withDatabase<T>(databasePath: string, use: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath, {timeout: 5_000});
  try {
    return use(database);
  } finally {
    database.close();
  }
}

function schemaVersion(databasePath: string): number {
  return withDatabase(databasePath, (database) =>
    z.object({user_version: z.number().int()})
      .parse(database.prepare("PRAGMA user_version").get()).user_version
  );
}

function managedKeyCount(databasePath: string): number {
  return withDatabase(databasePath, (database) =>
    z.object({count: z.number().int()})
      .parse(database.prepare("SELECT count(*) AS count FROM managed_api_keys").get()).count
  );
}

function compactStart(dataDirectory: string, port: number): string[] {
  return ["start-compact", "--data", dataDirectory, "--port", String(port)];
}

function startCli(
  cliArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(repositoryRoot, "src/cli/main.ts"), ...cliArguments],
    {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  runningProcesses.add(child);
  return child;
}

function runCli(
  cliArguments: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<{readonly exitCode: number; readonly output: string}> {
  return new Promise((resolve, reject) => {
    const child = startCli(cliArguments, environment);
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      runningProcesses.delete(child);
      resolve({
        exitCode: exitCode ?? -1,
        output: Buffer.concat(output).toString("utf8").trim(),
      });
    });
  });
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Process did not emit ${expected}: ${output}`));
    }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Process exited before ${expected}: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function waitForServiceRecord(
  dataDirectory: string,
  pid: number | undefined,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  const attempt = async (): Promise<string> => {
    try {
      const raw = await readFile(path.join(dataDirectory, "local-service.json"), "utf8");
      if (serviceRecordSchema.parse(JSON.parse(raw)).pid === pid) return raw;
    } catch {
      // The record appears after the listener is ready.
    }
    if (Date.now() >= deadline) throw new Error("The service record never named the server.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return attempt();
  };
  return attempt();
}

async function killAndWait(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<void> {
  const exited = processExit(child);
  child.kill(signal);
  await exited;
  runningProcesses.delete(child);
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function isReady(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
  } catch {
    return false;
  }
}

function availablePort(): Promise<number> {
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-server-lock-"));
  temporaryDirectories.add(directory);
  return directory;
}
