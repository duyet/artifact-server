import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {
  type UnknownDirectoryUserPolicy,
  unknownDirectoryUserPolicies,
} from "../../src/core/directory-sign-in.js";
import {
  createLdapDirectoryAuthenticator,
  type LdapDirectoryConfiguration,
} from "../../src/directory/ldap-directory-authenticator.js";
import {
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  type FakeLdapDirectory,
  type FakeLdapEntry,
  startFakeLdapDirectory,
} from "../support/fake-ldap-directory.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const people = "ou=people,dc=example,dc=com";
const userDnTemplate = `uid={username},${people}`;
const editors = "cn=editors,ou=groups,dc=example,dc=com";
const alicePassword = "correct horse battery staple";
const bootstrapAdministratorEmail = "administrator@example.test";

const sessionSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    displayName: z.string(),
    id: z.string(),
    kind: z.string(),
    membershipRole: z.string(),
  }).loose(),
});
const errorSchema = z.object({error: z.object({code: z.string(), message: z.string()})});

function directoryEntry(
  password: string,
  attributes: Readonly<Record<string, readonly string[]>>,
): FakeLdapEntry {
  return {attributes, password};
}

const entries = {
  [`uid=alice,${people}`]: directoryEntry(alicePassword, {
    displayName: ["Alice Example"],
    mail: ["Alice@Example.COM"],
    memberOf: [editors],
  }),
  [`uid=carol,${people}`]: directoryEntry("carol password", {
    displayName: ["Carol Example"],
    mail: ["carol@example.com"],
  }),
  [`uid=dave,${people}`]: directoryEntry("dave password", {
    displayName: ["Dave Example"],
    mail: ["dave@example.com"],
  }),
  [`uid=nomail,${people}`]: directoryEntry("nomail password", {displayName: ["No Mail"]}),
  // The RFC 4514 escaped form of the username `o,brien+x$&`.
  [`uid=o\\,brien\\+x$&,${people}`]: directoryEntry("obrien password", {
    mail: ["obrien@example.com"],
  }),
} satisfies Readonly<Record<string, FakeLdapEntry>>;

function ldapConfiguration(
  directory: FakeLdapDirectory,
  overrides: Partial<LdapDirectoryConfiguration> = {},
): LdapDirectoryConfiguration {
  return {
    caCertificates: null,
    displayNameAttribute: "displayName",
    emailAttribute: "mail",
    requiredGroupDn: null,
    timeoutMilliseconds: 2_000,
    url: directory.url,
    userDnTemplate,
    ...overrides,
  };
}

function sameOriginHeaders(server: RunningTestServer) {
  return {
    "Content-Type": "application/json",
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function signIn(
  server: RunningTestServer,
  username: string,
  password: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}/auth/ldap`, {
    body: JSON.stringify({password, username}),
    headers: sameOriginHeaders(server),
    method: "POST",
  });
}

interface BrowserCookies {
  readonly csrf: string;
  readonly header: string;
}

function browserCookies(response: Response): BrowserCookies {
  const pairs = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0] ?? "");
  const session = pairs.find((pair) => pair.startsWith("artifact_session="));
  const csrf = pairs.find((pair) => pair.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The sign-in response did not set both application cookies.");
  }
  return {csrf: csrf.slice("artifact_csrf=".length), header: `${session}; ${csrf}`};
}

async function sessionPrincipal(server: RunningTestServer, cookies: BrowserCookies) {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: cookies.header},
  });
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json()).principal;
}

async function expectRejected(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(errorSchema.parse(await response.json()).error).toEqual({
    code: "AUTHENTICATION_REQUIRED",
    message: "The username or password was not accepted.",
  });
}

async function selfSignedLocalhostCertificate(
  directory: string,
): Promise<{readonly certificate: string; readonly key: string}> {
  const keyPath = path.join(directory, "key.pem");
  const certificatePath = path.join(directory, "certificate.pem");
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost",
    "-keyout", keyPath, "-out", certificatePath,
  ]);
  return {
    certificate: await readFile(certificatePath, "utf8"),
    key: await readFile(keyPath, "utf8"),
  };
}

describe("LDAP browser sign-in", () => {
  let installation: TestInstallation;
  let directory: FakeLdapDirectory;
  let server: RunningTestServer | undefined;

  const running = (): RunningTestServer => {
    if (server === undefined) throw new Error("The test server is not running.");
    return server;
  };

  /** Dave's member is deactivated, so his directory sign-in must never revive it. */
  async function seedDeactivatedMember(): Promise<void> {
    const repository = new SqliteIdentityRepository(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      await repository.admitMember({
        createdAt: "2026-10-26T00:00:00.000Z",
        displayName: "Dave Example",
        email: "dave@example.com",
        id: "member_dave",
        installationId: "local",
        role: "member",
      });
      await repository.deactivateMember("local", "member_dave", "2026-10-26T00:00:01.000Z");
    } finally {
      repository.close();
    }
  }

  /** The member key alice publishes with, so her LDAP session must own its artifacts. */
  async function issueAliceKey() {
    const runtime = await createLocalRuntime({
      apiToken: installation.apiToken,
      bootstrapAdministratorEmail,
      browserAccess: localOwnerBrowserAccess,
      contentDomain: null,
      dataDirectory: installation.dataDirectory,
    });
    try {
      return await runtime.issueOperatorKey({
        displayName: "Alice Example",
        email: "alice@example.com",
        expiresAt: "2099-01-01T00:00:00.000Z",
        keyName: "Alice @ laptop",
        role: "member",
      });
    } finally {
      await runtime.close();
    }
  }

  async function start(options: {
    readonly configuration?: Partial<LdapDirectoryConfiguration>;
    readonly observability?: boolean;
    readonly unknownUsers?: UnknownDirectoryUserPolicy;
  } = {}): Promise<RunningTestServer> {
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        authenticator: createLdapDirectoryAuthenticator(
          ldapConfiguration(directory, options.configuration),
        ),
        unknownUsers: options.unknownUsers ?? unknownDirectoryUserPolicies.reject,
      }),
      contentDomain: null,
      observability: options.observability ?? false,
    });
    return server;
  }

  beforeEach(async () => {
    installation = await createTestInstallation();
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
    directory = await startFakeLdapDirectory({entries});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop();
    server = undefined;
    await directory.stop();
    await removeTestInstallation(installation);
  });

  test("FRK-022-B: a directory user signs in as the member their email names and edits the artifacts that member owns", async () => {
    const alice = await issueAliceKey();
    await start();
    const context = await fetch(`${running().baseUrl}/auth/context`);
    expect(await context.json()).toEqual({
      accessMode: "private_team",
      login: {directory: true, kind: "none"},
    });
    const published = await publishNew(running(), {...installation, apiToken: alice.issued.token}, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Alice's report</title>",
      idempotencyKey: "frk-022-alice-report",
      name: "Alice's report",
    });
    expect(published.response.status).toBe(201);

    const response = await signIn(running(), "alice", alicePassword);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const cookies = browserCookies(response);
    const principal = await sessionPrincipal(running(), cookies);
    expect(principal).toMatchObject({
      displayName: "Alice Example",
      id: alice.member.id,
      kind: "human",
      membershipRole: "member",
    });
    expect(directory.binds).toEqual([`uid=alice,${people}`]);

    const renamed = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${published.body.artifact.id}/name`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
          name: "Alice's renamed report",
        }),
        headers: {
          ...sameOriginHeaders(running()),
          Cookie: cookies.header,
          "Idempotency-Key": "frk-022-alice-rename",
          "X-CSRF-Token": cookies.csrf,
        },
        method: "PATCH",
      },
    );
    expect(renamed.status).toBe(200);
  });

  test("admit creates one member for a new directory user and reuses it on the next sign-in", async () => {
    await start({unknownUsers: unknownDirectoryUserPolicies.admit});
    const first = await sessionPrincipal(
      running(),
      browserCookies(await signIn(running(), "carol", "carol password")),
    );
    expect(first).toMatchObject({
      displayName: "Carol Example",
      kind: "human",
      membershipRole: "member",
    });
    const second = await sessionPrincipal(
      running(),
      browserCookies(await signIn(running(), "carol", "carol password")),
    );
    expect(second.id).toBe(first.id);
  });

  test("a username with DN special characters binds as its own escaped DN, and a required group admits its members", async () => {
    await start({
      configuration: {requiredGroupDn: editors.toUpperCase()},
      unknownUsers: unknownDirectoryUserPolicies.admit,
    });
    expect((await signIn(running(), "alice", alicePassword)).status).toBe(204);
    await expectRejected(await signIn(running(), "o,brien+x$&", "obrien password"));
    expect(directory.binds).toContain(`uid=o\\,brien\\+x$&,${people}`);

    await server?.stop();
    await start({unknownUsers: unknownDirectoryUserPolicies.admit});
    expect((await signIn(running(), "o,brien+x$&", "obrien password")).status).toBe(204);
  });

  test("FRK-022-F: a wrong password, a user with no member, a deactivated member, a missing email, and a user outside the required group get the same 401", async () => {
    await seedDeactivatedMember();
    await start({configuration: {requiredGroupDn: editors}});
    const wrongPassword = await signIn(running(), "alice", "wrong password");
    expect(wrongPassword.status).toBe(401);
    await expectRejected(wrongPassword);
    await expectRejected(await signIn(running(), "carol", "carol password"));
    await server?.stop();

    await start({unknownUsers: unknownDirectoryUserPolicies.admit});
    await expectRejected(await signIn(running(), "dave", "dave password"));
    await expectRejected(await signIn(running(), "nomail", "nomail password"));
    await expectRejected(await signIn(running(), "nobody", "any password"));
    await server?.stop();

    await start({
      configuration: {requiredGroupDn: editors},
      unknownUsers: unknownDirectoryUserPolicies.admit,
    });
    await expectRejected(await signIn(running(), "carol", "carol password"));
  });

  test("an empty password never reaches the directory, because an empty simple bind is anonymous and succeeds", async () => {
    await start();
    const response = await signIn(running(), "alice", "");
    expect(response.status).toBe(422);
    expect(response.headers.getSetCookie()).toEqual([]);

    const authenticator = createLdapDirectoryAuthenticator(ldapConfiguration(directory));
    const rejected = await Effect.runPromise(Effect.flip(
      authenticator.authenticate("alice", Redacted.make("")),
    ));
    expect(rejected).toMatchObject({_tag: "DirectorySignInRejected", reason: "invalid_credentials"});
    expect(directory.binds).toEqual([]);
  });

  test("usernames that try to rewrite the DN bind only as their own escaped value", async () => {
    await start({unknownUsers: unknownDirectoryUserPolicies.admit});
    const attempts = [
      `alice,${people}`,
      `uid=alice,${people}`,
      "alice+uid=alice",
      "*",
      "alice)(uid=*",
      " alice",
      "#alice",
      "alice\0",
      "EXTERNAL",
    ];
    const rejectAll = (usernames: readonly string[]) =>
      Promise.all(usernames.map(async (username) =>
        expectRejected(await signIn(running(), username, alicePassword))));
    // A fresh server for the last four keeps the failed sign-in limit out of the way.
    await rejectAll(attempts.slice(0, 5));
    await server?.stop();
    await start({unknownUsers: unknownDirectoryUserPolicies.admit});
    await rejectAll(attempts.slice(5));
    expect(directory.binds.toSorted()).toEqual([
      `uid=alice\\,ou=people\\,dc=example\\,dc=com,${people}`,
      `uid=uid=alice\\,ou=people\\,dc=example\\,dc=com,${people}`,
      `uid=alice\\+uid=alice,${people}`,
      `uid=*,${people}`,
      `uid=alice)(uid=*,${people}`,
      `uid=\\ alice,${people}`,
      `uid=\\#alice,${people}`,
      `uid=alice\\00,${people}`,
      `uid=EXTERNAL,${people}`,
    ].toSorted());
  });

  test("LDAP and API-key failures share the per-client limit, and a limited client never reaches the directory", async () => {
    await start();
    const apiKeySignIn = () => fetch(`${running().baseUrl}/auth/api-key`, {
      body: JSON.stringify({
        apiKey: "as_key_key_00000000-0000-4000-8000-000000000009_wrongSecretWithSufficientEntropy1234",
      }),
      headers: sameOriginHeaders(running()),
      method: "POST",
    });
    const failures = await Promise.all([
      signIn(running(), "alice", "wrong password"),
      signIn(running(), "alice", "wrong password"),
      signIn(running(), "alice", "wrong password"),
      apiKeySignIn(),
      apiKeySignIn(),
    ]);
    expect(failures.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    const bindsBefore = directory.binds.length;
    const limited = await signIn(running(), "alice", alicePassword);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(errorSchema.parse(await limited.json()).error.code).toBe("RATE_LIMITED");
    expect(directory.binds.length).toBe(bindsBefore);
  });

  test("an unreachable or silent directory is 503 DIRECTORY_UNAVAILABLE within the timeout and is not counted as a failed sign-in", async () => {
    const closedPort = await reserveLoopbackPort();
    await start({configuration: {url: `ldap://127.0.0.1:${closedPort}`}});
    const unavailable = await Promise.all(
      Array.from({length: 5}, () => signIn(running(), "alice", alicePassword)),
    );
    expect(unavailable.map((response) => response.status)).toEqual([503, 503, 503, 503, 503]);
    const afterFive = await signIn(running(), "alice", alicePassword);
    expect(afterFive.status).toBe(503);
    expect(errorSchema.parse(await afterFive.json()).error.code).toBe("DIRECTORY_UNAVAILABLE");
    await server?.stop();

    const silent = await startFakeLdapDirectory({entries, silent: true});
    try {
      await start({configuration: {timeoutMilliseconds: 300, url: silent.url}});
      const startedAt = performance.now();
      const response = await signIn(running(), "alice", alicePassword);
      expect(response.status).toBe(503);
      expect(performance.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await silent.stop();
    }
  });

  test("ldaps verifies the directory against the configured CA, and an untrusted certificate is unavailable, not a wrong password", async () => {
    const certificates = await mkdtemp(path.join(tmpdir(), "artifact-server-ldaps-"));
    try {
      const tls = await selfSignedLocalhostCertificate(certificates);
      const secure = await startFakeLdapDirectory({entries, tls});
      try {
        await issueAliceKey();
        await start({configuration: {caCertificates: tls.certificate, url: secure.url}});
        expect((await signIn(running(), "alice", alicePassword)).status).toBe(204);
        await server?.stop();

        await start({configuration: {url: secure.url}});
        const untrusted = await signIn(running(), "alice", alicePassword);
        expect(untrusted.status).toBe(503);
        expect(errorSchema.parse(await untrusted.json()).error.code).toBe("DIRECTORY_UNAVAILABLE");
      } finally {
        await secure.stop();
      }
    } finally {
      await rm(certificates, {force: true, recursive: true});
    }
  });

  test("each attempt writes one audit line with the username and outcome, and no line holds the password", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
    await issueAliceKey();
    await start({observability: true});
    expect((await signIn(running(), "alice", alicePassword)).status).toBe(204);
    await expectRejected(await signIn(running(), "carol", "carol password"));
    await expectRejected(await signIn(running(), "alice", "a distinctive wrong password"));

    const audit = lines.filter((line) => line.includes("auth.directory_sign_in."));
    expect(audit).toHaveLength(3);
    expect(audit[0]).toContain("auth.directory_sign_in.succeeded");
    expect(audit[0]).toContain("alice");
    expect(audit[1]).toContain("auth.directory_sign_in.rejected");
    expect(audit[1]).toContain("no_member");
    expect(audit[2]).toContain("invalid_credentials");
    for (const line of lines) {
      expect(line).not.toContain(alicePassword);
      expect(line).not.toContain("a distinctive wrong password");
    }
  });

  test("a server without LDAP sign-in has no LDAP route", async () => {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    });
    expect((await signIn(running(), "alice", alicePassword)).status).toBe(404);
    expect(directory.binds).toEqual([]);
  });
});

describe("LDAP sign-in configuration", () => {
  const base: NodeJS.ProcessEnv = {
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
  const ldap = {
    ARTIFACT_SERVER_LDAP_URL: "ldaps://ldap.example.com:636",
    ARTIFACT_SERVER_LDAP_USER_DN: "uid={username},cn=users,cn=accounts,dc=example,dc=com",
  };

  const parse = (environment: NodeJS.ProcessEnv) =>
    Effect.runPromise(parseExternalStorageRuntimeConfiguration({
      environment: {...base, ...environment},
      hostname: "127.0.0.1",
      port: "8787",
    }));

  test("LDAP sign-in is off without a URL, and on with safe defaults when one is set", async () => {
    expect((await parse({})).ldapSignIn).toBeNull();
    const configured = await parse(ldap);
    expect(configured.ldapSignIn).toEqual({
      directory: {
        caCertificates: null,
        displayNameAttribute: "displayName",
        emailAttribute: "mail",
        requiredGroupDn: null,
        timeoutMilliseconds: 5_000,
        url: "ldaps://ldap.example.com:636",
        userDnTemplate: ldap.ARTIFACT_SERVER_LDAP_USER_DN,
      },
      unknownUsers: "reject",
    });
    expect(summarizeRuntimeConfiguration(configured).ldapSignIn).toEqual({
      caFile: false,
      requiredGroup: null,
      unknownUsers: "reject",
      url: "ldaps://ldap.example.com:636",
    });
  });

  test("clear-text URLs, unsafe DN templates, unknown choices, and unreadable CA files are refused at startup", async () => {
    const refused = (environment: NodeJS.ProcessEnv) =>
      expect(parse({...ldap, ...environment})).rejects.toMatchObject({
        reason: expect.stringMatching(/^(invalid_value|missing_value|path_unavailable)$/u),
      });
    await refused({ARTIFACT_SERVER_LDAP_URL: "ldap://ldap.example.com"});
    await refused({ARTIFACT_SERVER_LDAP_URL: "https://ldap.example.com"});
    await refused({ARTIFACT_SERVER_LDAP_URL: "ldaps://user:secret@ldap.example.com"});
    await refused({ARTIFACT_SERVER_LDAP_USER_DN: ""});
    await refused({ARTIFACT_SERVER_LDAP_USER_DN: "{username}"});
    await refused({ARTIFACT_SERVER_LDAP_USER_DN: "{username}@example.com"});
    await refused({ARTIFACT_SERVER_LDAP_USER_DN: "uid=x{username},dc=example,dc=com"});
    await refused({ARTIFACT_SERVER_LDAP_USER_DN: "uid={username},cn={username},dc=example,dc=com"});
    await refused({ARTIFACT_SERVER_LDAP_UNKNOWN_USERS: "maybe"});
    await refused({ARTIFACT_SERVER_LDAP_EMAIL_ATTRIBUTE: "mail)(uid=*"});
    await refused({ARTIFACT_SERVER_LDAP_TIMEOUT_MS: "0"});
    await refused({ARTIFACT_SERVER_LDAP_CA_FILE: "/nonexistent/ca.pem"});

    const directory = await mkdtemp(path.join(tmpdir(), "artifact-server-ldap-ca-"));
    try {
      const notPem = path.join(directory, "ca.txt");
      await writeFile(notPem, "not a certificate");
      await refused({ARTIFACT_SERVER_LDAP_CA_FILE: notPem});
    } finally {
      await rm(directory, {force: true, recursive: true});
    }

    expect((await parse({
      ...ldap,
      ARTIFACT_SERVER_LDAP_ALLOW_INSECURE: "true",
      ARTIFACT_SERVER_LDAP_URL: "ldap://ldap.example.com:389",
    })).ldapSignIn?.directory.url).toBe("ldap://ldap.example.com:389");
  });
});
