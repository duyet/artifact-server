import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {initializeCompactInstallation} from "../../src/lifecycle/compact-installation.js";
import {
  parseCompactRuntimeConfiguration,
  parseExternalStorageRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const bootstrapAdministratorEmail = "administrator@example.test";
const helpUrl = "https://help.example.com/artifact-server";
const externalEnvironment: NodeJS.ProcessEnv = {
  ARTIFACT_SERVER_API_TOKEN:
    `as_key_key_00000000-0000-4000-8000-000000000000_${"a".repeat(40)}`,
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
  ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
  ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
  ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-key",
  ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
  ARTIFACT_SERVER_S3_REGION: "us-east-1",
  ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access-key",
};
const accountSchema = z.object({
  account: z.object({displayName: z.string(), email: z.string().nullable()}).strict(),
}).loose();
const contextSchema = z.object({helpUrl: z.string().nullable()}).loose();

function sameOriginHeaders(server: RunningTestServer) {
  return {
    "Content-Type": "application/json",
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

/** Sign a browser in with one key, as the sign-in form does; returns the Cookie header. */
async function signIn(server: RunningTestServer, apiKey: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers: sameOriginHeaders(server),
    method: "POST",
  });
  expect(response.status).toBe(204);
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter((pair) => pair.startsWith("artifact_session=") || pair.startsWith("artifact_csrf="))
    .join("; ");
}

function csrfToken(cookie: string): string {
  const pair = cookie.split("; ").find((value) => value.startsWith("artifact_csrf="));
  if (pair === undefined) throw new Error("The cookie header holds no CSRF token.");
  return pair.slice("artifact_csrf=".length);
}

async function readSession(
  server: RunningTestServer,
  headers: Readonly<Record<string, string>>,
): Promise<{readonly account: z.infer<typeof accountSchema>["account"]; readonly text: string}> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {headers});
  expect(response.status).toBe(200);
  const text = await response.text();
  return {account: accountSchema.parse(JSON.parse(text)).account, text};
}

function parseExternal(environment: NodeJS.ProcessEnv) {
  return Effect.runPromise(parseExternalStorageRuntimeConfiguration({
    environment: {...externalEnvironment, ...environment},
    hostname: "127.0.0.1",
    port: "8787",
  }));
}

describe("account menu session and help link", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;

  const running = (): RunningTestServer => {
    if (server === undefined) throw new Error("The test server is not running.");
    return server;
  };

  /** Mint one member and its operator key, as `admin issue-key` does. */
  async function issueMemberKey(
    displayName: string,
    email: string,
    role: "administrator" | "member" = "member",
  ): Promise<{readonly memberId: string; readonly token: string}> {
    const runtime = await createLocalRuntime({
      apiToken: installation.apiToken,
      bootstrapAdministratorEmail,
      browserAccess: localOwnerBrowserAccess,
      contentDomain: null,
      dataDirectory: installation.dataDirectory,
    });
    try {
      const {issued, member} = await runtime.issueOperatorKey({
        displayName,
        email,
        expiresAt: "2099-01-01T00:00:00.000Z",
        keyName: `${displayName} laptop`,
        role,
      });
      return {memberId: member.id, token: issued.token};
    } finally {
      await runtime.close();
    }
  }

  beforeEach(async () => {
    installation = await createTestInstallation();
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await removeTestInstallation(installation);
  });

  test("FRK-031-B: a member's session names their own display name and email, and a configured help URL reaches /auth/context", async () => {
    const alice = (await issueMemberKey("Alice Example", "alice@example.com")).token;
    await issueMemberKey("Bob Example", "bob@example.com");
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
      helpUrl,
    });

    const context = await fetch(`${running().baseUrl}/auth/context`);
    expect(contextSchema.parse(await context.json()).helpUrl).toBe(helpUrl);

    const {account, text} = await readSession(running(), {
      Cookie: await signIn(running(), alice),
    });
    expect(account).toEqual({displayName: "Alice Example", email: "alice@example.com"});
    // The account is the caller's own, never another member's.
    expect(text).not.toContain("bob@example.com");
    expect(text).not.toContain("Bob Example");

    expect((await parseExternal({ARTIFACT_SERVER_HELP_URL: helpUrl})).helpUrl).toBe(helpUrl);
    expect((await parseExternal({})).helpUrl).toBeNull();
    expect((await parseExternal({ARTIFACT_SERVER_HELP_URL: ""})).helpUrl).toBeNull();
    const compactRoot = await mkdtemp(path.join(tmpdir(), "frk-031-compact-"));
    const compactData = path.join(compactRoot, "data");
    try {
      await Effect.runPromise(initializeCompactInstallation({
        bootstrapAdministratorEmail: "admin@example.test",
        dataDirectory: compactData,
      }));
      const compact = await Effect.runPromise(parseCompactRuntimeConfiguration({
        dataDirectory: compactData,
        environment: {
          ARTIFACT_SERVER_HELP_URL: helpUrl,
          ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
          ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
        },
        hostname: "127.0.0.1",
        port: "8787",
      }));
      expect(compact.helpUrl).toBe(helpUrl);
    } finally {
      await rm(compactRoot, {force: true, recursive: true});
    }
  });

  test("FRK-031-F: a key, even one carrying a member's principal, reads no email; no help URL reads null; an unsafe help URL stops startup", async () => {
    const alice = await issueMemberKey("Alice Example", "alice@example.com");
    const administrator = await issueMemberKey("Admin Example", "admin@example.com", "administrator");
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    });

    const context = await fetch(`${running().baseUrl}/auth/context`);
    expect(contextSchema.parse(await context.json()).helpUrl).toBeNull();

    // Bearer use of an operator key stays delegated, so it is a key acting
    // on Alice's principal, not Alice, and must not learn her email.
    const aliceBearer = await readSession(running(), {Authorization: `Bearer ${alice.token}`});
    expect(aliceBearer.account).toEqual({displayName: "Alice Example laptop", email: null});
    expect(aliceBearer.text).not.toContain("alice@example.com");

    const bootstrapBearer = await readSession(running(), {
      Authorization: `Bearer ${installation.apiToken}`,
    });
    expect(bootstrapBearer.account.email).toBeNull();

    // A key an administrator issues on Alice's principal signs a browser in
    // as that key, so its session reads no email either.
    const administratorCookie = await signIn(running(), administrator.token);
    const issued = await fetch(`${running().baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId: alice.memberId,
        name: "Alice reader",
      }),
      headers: {
        ...sameOriginHeaders(running()),
        Cookie: administratorCookie,
        "X-CSRF-Token": csrfToken(administratorCookie),
      },
      method: "POST",
    });
    expect(issued.status).toBe(201);
    const readerKey = z.object({token: z.string()}).parse(await issued.json()).token;
    const reader = await readSession(running(), {Cookie: await signIn(running(), readerKey)});
    expect(reader.account).toEqual({displayName: "Alice reader", email: null});

    const anonymous = await fetch(`${running().baseUrl}/api/v1/session`);
    expect(anonymous.status).toBe(401);

    const field = "ARTIFACT_SERVER_HELP_URL";
    const refused = await Promise.all([
      "http://help.example.com/",
      "javascript:alert(1)",
      "https://user:secret@help.example.com/",
      "/docs/help",
      "help.example.com",
    ].map(async (value) => {
      const failure = await Effect.runPromise(Effect.flip(
        parseExternalStorageRuntimeConfiguration({
          environment: {...externalEnvironment, [field]: value},
          hostname: "127.0.0.1",
          port: "8787",
        }),
      ));
      return {field: failure.field, reason: failure.reason};
    }));
    expect(refused).toEqual(Array.from({length: 5}, () => ({field, reason: "invalid_value"})));
  });
});
