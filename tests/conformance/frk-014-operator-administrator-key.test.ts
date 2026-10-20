import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {access, mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const applicationOrigin = "https://artifacts.example.com";
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const issuedSchema = z.object({
  apiKey: z.object({expiresAt: z.string(), id: z.string()}),
  member: z.object({displayName: z.string(), email: z.string(), id: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const sessionSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    authorizedByPrincipalId: z.null(),
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const keyListSchema = z.object({
  apiKeys: z.array(z.object({id: z.string(), principalId: z.string()})),
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface BrowserSession {
  readonly cookie: string;
  readonly csrf: string;
}

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

// Each test spawns several CLI processes, which is slow on a loaded machine.
const processTestTimeoutMilliseconds = 90_000;

describe("operator administrator key", {timeout: processTestTimeoutMilliseconds}, () => {
  test("FRK-014-B: an operator key signs a person in as an administrator who can admit members and issue keys", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "frk-014-"));
    const dataDirectory = path.join(parent, "data");
    try {
      expect((await runCli([
        "init",
        "--admin-email",
        "bootstrap@example.test",
        "--data",
        dataDirectory,
      ])).exitCode).toBe(0);

      const first = await issueKey(dataDirectory, "ops@example.test", "Ops Lead");
      expect(first.result.exitCode).toBe(0);
      const repeated = await issueKey(dataDirectory, "OPS@example.test", "Ops Lead");
      expect(repeated.result.exitCode).toBe(0);
      expect(repeated.issued.member.id).toBe(first.issued.member.id);
      expect(repeated.issued.apiKey.id).not.toBe(first.issued.apiKey.id);

      const port = await availablePort();
      const server = startCli(
        ["start-compact", "--data", dataDirectory, "--port", String(port)],
        compactEnvironment(),
      );
      const serverOutput = collectOutput(server);
      await waitForOutput(server, '"status":"ready"');
      const baseUrl = `http://127.0.0.1:${port}`;

      // Re-issuing the same key name replaced the first key.
      expect((await apiKeySignIn(baseUrl, first.issued.token)).status).toBe(401);
      const session = await signIn(baseUrl, repeated.issued.token);
      const principal = sessionSchema.parse(await (await fetch(
        `${baseUrl}/api/v1/session`,
        {headers: {Cookie: session.cookie}},
      )).json()).principal;
      expect(principal.id).toBe(first.issued.member.id);

      const admitted = await fetch(`${baseUrl}/api/v1/members`, {
        body: JSON.stringify({
          displayName: "Reviewer",
          email: "reviewer@example.test",
          role: "member",
        }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      const reviewer = memberSchema.parse(await admitted.json()).member;

      const reviewerKey = await fetch(`${baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({
          capabilities: ["artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId: reviewer.id,
          name: "Reviewer laptop",
        }),
        headers: mutationHeaders(session),
        method: "POST",
      });
      expect(reviewerKey.status).toBe(201);

      const listed = keyListSchema.parse(await (await fetch(
        `${baseUrl}/api/v1/api-keys`,
        {headers: {Cookie: session.cookie}},
      )).json()).apiKeys;
      expect(listed.filter((key) => key.principalId === first.issued.member.id)
        .map((key) => key.id).toSorted())
        .toEqual([first.issued.apiKey.id, repeated.issued.apiKey.id].toSorted());

      // The key is a sign-in credential: as a bearer it stays a delegated key.
      expect((await fetch(`${baseUrl}/api/v1/members`, {
        headers: {Authorization: `Bearer ${repeated.issued.token}`},
      })).status).toBe(403);

      await stopProcess(server);
      expect(serverOutput()).not.toContain(repeated.issued.token);

      const reviewerLaptop = await runCli([
        ...issueKeyArguments(dataDirectory, "reviewer@example.test", "Reviewer"),
        "--role",
        "member",
        "--key-name",
        "Reviewer @ laptop",
      ], compactEnvironment());
      expect(reviewerLaptop.exitCode).toBe(0);
      expect(JSON.parse(reviewerLaptop.stdout)).toMatchObject({
        apiKey: {name: "Reviewer @ laptop"},
        member: {id: reviewer.id, role: "member"},
      });
    } finally {
      await rm(parent, {force: true, recursive: true});
    }
  });

  test("FRK-014-F: a missing installation creates nothing, a non-administrator email gets no key, and the secret stays out of logs", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "frk-014-"));
    const dataDirectory = path.join(parent, "data");
    try {
      const missing = await runCli(issueKeyArguments(
        dataDirectory,
        "ops@example.test",
        "Ops Lead",
      ), compactEnvironment());
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stdout).not.toContain("as_key_");
      await expect(access(dataDirectory)).rejects.toMatchObject({code: "ENOENT"});

      expect((await runCli([
        "init",
        "--admin-email",
        "bootstrap@example.test",
        "--data",
        dataDirectory,
      ])).exitCode).toBe(0);
      const issued = await issueKey(dataDirectory, "ops@example.test", "Ops Lead");
      expect(issued.result.exitCode).toBe(0);
      expect(issued.result.stdout.split(issued.issued.token)).toHaveLength(2);
      expect(issued.result.stderr).not.toContain(issued.issued.token);

      const port = await availablePort();
      const server = startCli(
        ["start-compact", "--data", dataDirectory, "--port", String(port)],
        compactEnvironment(),
      );
      await waitForOutput(server, '"status":"ready"');
      const baseUrl = `http://127.0.0.1:${port}`;
      const session = await signIn(baseUrl, issued.issued.token);
      expect((await fetch(`${baseUrl}/api/v1/members`, {
        body: JSON.stringify({
          displayName: "Reader",
          email: "reader@example.test",
          role: "member",
        }),
        headers: mutationHeaders(session),
        method: "POST",
      })).status).toBe(201);
      const keysBefore = keyListSchema.parse(await (await fetch(
        `${baseUrl}/api/v1/api-keys`,
        {headers: {Cookie: session.cookie}},
      )).json()).apiKeys;
      await stopProcess(server);

      const reader = await runCli(issueKeyArguments(
        dataDirectory,
        "reader@example.test",
        "Reader",
      ), compactEnvironment());
      expect(reader.exitCode).not.toBe(0);
      expect(reader.stdout).not.toContain("as_key_");
      expect(`${reader.stdout}${reader.stderr}`).toContain("role is member, not administrator");

      const restarted = startCli(
        ["start-compact", "--data", dataDirectory, "--port", String(port)],
        compactEnvironment(),
      );
      await waitForOutput(restarted, '"status":"ready"');
      const keysAfter = keyListSchema.parse(await (await fetch(
        `${baseUrl}/api/v1/api-keys`,
        {headers: {Cookie: session.cookie}},
      )).json()).apiKeys;
      expect(keysAfter.map((key) => key.id).toSorted())
        .toEqual(keysBefore.map((key) => key.id).toSorted());
    } finally {
      await rm(parent, {force: true, recursive: true});
    }
  });
});

function issueKeyArguments(
  dataDirectory: string,
  email: string,
  name: string,
): readonly string[] {
  return [
    "admin",
    "issue-key",
    "--mode",
    "compact",
    "--data",
    dataDirectory,
    "--email",
    email,
    "--name",
    name,
  ];
}

async function issueKey(
  dataDirectory: string,
  email: string,
  name: string,
): Promise<{
  readonly issued: z.infer<typeof issuedSchema>;
  readonly result: ProcessResult;
}> {
  const result = await runCli(
    issueKeyArguments(dataDirectory, email, name),
    compactEnvironment(),
  );
  if (result.exitCode !== 0) {
    throw new Error(`admin issue-key failed: ${result.stderr}`);
  }
  return {issued: issuedSchema.parse(JSON.parse(result.stdout)), result};
}

function apiKeySignIn(baseUrl: string, apiKey: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers: {
      "Content-Type": "application/json",
      Origin: applicationOrigin,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    method: "POST",
  });
}

async function signIn(baseUrl: string, apiKey: string): Promise<BrowserSession> {
  const response = await apiKeySignIn(baseUrl, apiKey);
  expect(response.status).toBe(204);
  const pairs = response.headers.getSetCookie().map((value) =>
    value.split(";", 1)[0] ?? ""
  );
  const csrfPair = pairs.find((pair) => pair.startsWith("__Host-artifact_csrf="));
  if (csrfPair === undefined || pairs.length !== 2) {
    throw new Error("API-key sign-in did not issue both application cookies.");
  }
  return {
    cookie: pairs.join("; "),
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
  };
}

function mutationHeaders(session: BrowserSession): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Origin: applicationOrigin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": session.csrf,
  });
}

function compactEnvironment(): NodeJS.ProcessEnv {
  return {
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "1",
  };
}

function startCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    path.join(repositoryRoot, "node_modules/.bin/tsx"),
    [path.join(repositoryRoot, "src/cli/main.ts"), ...arguments_],
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
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = startCli(arguments_, environment);
    runningProcesses.delete(child);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

function collectOutput(child: ChildProcessWithoutNullStreams): () => string {
  const output: Uint8Array[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  return () => Buffer.concat(output).toString("utf8");
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
    }, 15_000);
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

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
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
