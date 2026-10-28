import {createHash, randomUUID} from "node:crypto";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Redacted} from "effect";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {installationOperatorActor} from "../../src/core/installation-identity.js";
import {unknownOidcUserPolicies} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "../support/agent-dispatch.js";
import {
  type FakeOidcPerson,
  type FakeOidcProvider,
  startFakeOidcProvider,
} from "../support/fake-oidc-provider.js";
import {
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const redirectUri = "https://artifacts.example.com/auth/oidc/callback";
const operatorPrincipalId = "installation-operator";
const memberKeyCapabilities = [
  "artifact:create",
  "artifact:read",
  "comment:write",
  "content-session:issue",
];

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(z.string()),
  displayName: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.string(),
  membershipRole: z.string(),
}).strict();
type ResolvedPrincipal = z.infer<typeof principalSchema>;
const sessionSchema = z.object({principal: principalSchema}).loose();
const projectsSchema = z.object({projects: z.array(z.object({id: z.string()}).loose())});
const uploadPlanSchema = z.object({
  commitUrl: z.url().optional(),
  files: z.array(z.object({uploadUrl: z.url()}).loose()),
  uploadId: z.string(),
}).loose();
const publishedSchema = z.object({
  artifact: z.object({
    id: z.string(),
    owner: z.object({principalId: z.string()}).loose(),
  }).loose(),
  version: z.object({
    id: z.string(),
    publisherDisplayName: z.string().nullable(),
    publisherPrincipalId: z.string(),
  }).loose(),
}).loose();
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string()}).loose()).optional(),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const toolErrorSchema = z.object({error: z.object({code: z.string()})});

/** What a caller observed: the operation ran, policy refused it, or anything else verbatim. */
type Outcome = "allowed" | "denied" | `unexpected: ${string}`;

interface Published {
  readonly artifactId: string;
  readonly ownerId: string;
  readonly publisherId: string;
  readonly publisherName: string | null;
  readonly versionId: string;
}

/** Body fields that name a principal other than the caller. */
type ClaimedPrincipalFields = {
  readonly owner: {readonly principalId: string};
  readonly principal: {readonly id: string; readonly kind: string; readonly membershipRole: string};
  readonly principalId: string;
};

type Credential = Readonly<Record<string, string>>;
type JsonValue = string | number | boolean | null | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};
type ToolArguments = Readonly<Record<string, JsonValue>>;

/** The operations every authentication method is asked to perform. */
interface Client {
  readonly changeAccess: (artifact: Published, claimed?: ClaimedPrincipalFields) => Promise<Outcome>;
  readonly createProject: (name: string) => Promise<Outcome>;
  readonly publish: (name: string) => Promise<Published>;
  readonly read: (artifact: Published) => Promise<Outcome>;
}

interface Decisions {
  readonly changeOtherAccess: Outcome;
  readonly changeOwnAccess: Outcome;
  readonly createProject: Outcome;
  readonly readOther: Outcome;
}

interface BrowserCookies {
  readonly csrf: string;
  readonly header: string;
}

const runningServers: RunningTestServer[] = [];
const installations: TestInstallation[] = [];
const providers: FakeOidcProvider[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(installations.splice(0).map(removeTestInstallation));
  providers.splice(0);
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sitePage(name: string) {
  const bytes = new TextEncoder().encode(`<!doctype html><title>${name}</title>`);
  return {
    bytes,
    declared: [{
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
  };
}

async function httpOutcome(response: Response): Promise<Outcome> {
  if (response.ok) return "allowed";
  if (response.status === 403) return "denied";
  return `unexpected: ${response.status} ${await response.text()}`;
}

function toPublished(parsed: z.infer<typeof publishedSchema>): Published {
  return {
    artifactId: parsed.artifact.id,
    ownerId: parsed.artifact.owner.principalId,
    publisherId: parsed.version.publisherPrincipalId,
    publisherName: parsed.version.publisherDisplayName,
    versionId: parsed.version.id,
  };
}

function sameOriginHeaders(server: RunningTestServer) {
  return {
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function bearerCredential(token: string) {
  return {Authorization: `Bearer ${token}`};
}

function cookieCredential(
  server: RunningTestServer,
  cookies: BrowserCookies,
) {
  return {
    ...sameOriginHeaders(server),
    Cookie: cookies.header,
    "X-CSRF-Token": cookies.csrf,
  };
}

/** The HTTP API driven with one credential, a bearer key or a browser session. */
function httpClient(
  server: RunningTestServer,
  projectId: string,
  credential: Credential,
): Client {
  const send = (
    target: string,
    init: {readonly body?: unknown; readonly headers?: Credential; readonly method?: string} = {},
  ) => {
    const request: RequestInit = {
      headers: {"Content-Type": "application/json", ...credential, ...init.headers},
      method: init.method ?? "GET",
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    return fetch(target.startsWith("http") ? target : `${server.baseUrl}${target}`, request);
  };
  return {
    changeAccess: async (artifact, claimed) => httpOutcome(await send(
      `/api/v1/artifacts/${artifact.artifactId}/access?projectId=${projectId}`,
      {
        body: {
          ...claimed,
          accessSetting: "public_link",
          expectedCurrentVersionId: artifact.versionId,
        },
        headers: {"Idempotency-Key": randomUUID()},
        method: "PATCH",
      },
    )),
    createProject: async (name) => httpOutcome(await send("/api/v1/projects", {
      body: {name},
      method: "POST",
    })),
    publish: async (name) => {
      const page = sitePage(name);
      const planned = await send("/api/v1/uploads", {
        body: {entryPath: "index.html", files: page.declared, projectId},
        method: "POST",
      });
      expect(planned.status, `${name}: upload plan`).toBe(201);
      const plan = uploadPlanSchema.parse(await planned.json());
      const uploads = await Promise.all(plan.files.map((file) => fetch(file.uploadUrl, {
        body: page.bytes,
        headers: credential,
        method: "PUT",
      })));
      expect(uploads.map((uploaded) => uploaded.ok), `${name}: uploads`)
        .toEqual(plan.files.map(() => true));
      const committed = await send(plan.commitUrl ?? "", {
        body: {
          target: {accessSetting: "account_required", kind: "new_artifact", name, tags: []},
        },
        headers: {"Idempotency-Key": randomUUID()},
        method: "POST",
      });
      expect(committed.ok, `${name}: commit ${committed.status}`).toBe(true);
      return toPublished(publishedSchema.parse(await committed.json()));
    },
    read: async (artifact) => httpOutcome(
      await send(`/api/v1/artifacts/${artifact.artifactId}?projectId=${projectId}`),
    ),
  };
}

async function callTool(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: ToolArguments,
): Promise<Response> {
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "arc-005", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: toolArguments,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
}

/** The MCP endpoint driven with one bearer credential. */
function mcpClient(server: RunningTestServer, projectId: string, token: string): Client {
  const run = async (name: string, toolArguments: ToolArguments) => {
    const response = await callTool(server, token, name, toolArguments);
    expect(response.status, `${name}: MCP status`).toBe(200);
    return toolResultSchema.parse(await response.json()).result;
  };
  const outcome = async (name: string, toolArguments: ToolArguments): Promise<Outcome> => {
    const result = await run(name, toolArguments);
    if (result.isError !== true) return "allowed";
    const failure = toolErrorSchema.safeParse(result.structuredContent);
    if (!failure.success) {
      return `unexpected: ${result.content?.map((item) => item.text).join(" ") ?? ""}`;
    }
    const code = failure.data.error.code;
    return code === "AUTHORIZATION_DENIED" ? "denied" : `unexpected: ${code}`;
  };
  return {
    changeAccess: (artifact, claimed) => outcome("artifact_set_visibility", {
      ...claimed,
      accessSetting: "public_link",
      artifactId: artifact.artifactId,
      expectedCurrentVersionId: artifact.versionId,
      idempotencyKey: randomUUID(),
      projectId,
    }),
    createProject: (name) => outcome("project_create", {name}),
    publish: async (name) => {
      const page = sitePage(name);
      const planned = await run("artifact_create_upload", {
        entryPath: "index.html",
        files: page.declared,
        projectId,
      });
      expect(planned.isError, `${name}: MCP upload plan`).not.toBe(true);
      const plan = uploadPlanSchema.parse(planned.structuredContent);
      const uploads = await Promise.all(plan.files.map((file) => fetch(file.uploadUrl, {
        body: page.bytes,
        headers: bearerCredential(token),
        method: "PUT",
      })));
      expect(uploads.map((uploaded) => uploaded.ok), `${name}: MCP uploads`)
        .toEqual(plan.files.map(() => true));
      const committed = await run("artifact_commit_upload", {
        idempotencyKey: randomUUID(),
        projectId,
        target: {accessSetting: "account_required", kind: "new_artifact", name},
        uploadId: plan.uploadId,
      });
      expect(committed.isError, `${name}: MCP commit`).not.toBe(true);
      return toPublished(publishedSchema.parse(committed.structuredContent));
    },
    read: (artifact) => outcome("artifact_get", {artifactId: artifact.artifactId, projectId}),
  };
}

async function readPrincipal(
  server: RunningTestServer,
  credential: Credential,
): Promise<ResolvedPrincipal> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {headers: credential});
  expect(response.status).toBe(200);
  const principal = sessionSchema.parse(await response.json()).principal;
  return {...principal, capabilities: principal.capabilities.toSorted()};
}

async function sessionStatus(
  server: RunningTestServer,
  credential: Credential,
): Promise<number> {
  return (await fetch(`${server.baseUrl}/api/v1/session`, {headers: credential})).status;
}

/**
 * Run the fixed decision matrix as one caller, against an artifact the caller
 * publishes and one that `publishOther` publishes as someone else.
 */
async function decide(
  client: Client,
  publishOther: (name: string) => Promise<Published>,
  label: string,
): Promise<{readonly decisions: Decisions; readonly own: Published}> {
  const other = await publishOther(`Other for ${label}`);
  const own = await client.publish(`${label} own`);
  return {
    decisions: {
      changeOtherAccess: await client.changeAccess(other),
      changeOwnAccess: await client.changeAccess(own),
      createProject: await client.createProject(`${label} project`),
      readOther: await client.read(other),
    },
    own,
  };
}

function cookiePair(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`));
}

function browserCookies(response: Response): BrowserCookies {
  const session = cookiePair(response, "artifact_session");
  const csrf = cookiePair(response, "artifact_csrf");
  if (session === undefined || csrf === undefined) {
    throw new Error(`The sign-in response (${response.status}) set no application session.`);
  }
  return {csrf: csrf.slice("artifact_csrf=".length), header: `${session}; ${csrf}`};
}

interface MemberServer {
  readonly admin: {readonly cookies: BrowserCookies};
  readonly alice: {readonly id: string; readonly key: string; readonly keyId: string};
  readonly aliceShortKey: string;
  readonly bob: {readonly id: string; readonly key: string};
  readonly clock: MutableClock;
  readonly foreignSession: BrowserCookies;
  readonly foreignSessionToken: string;
  readonly projectId: string;
  readonly server: RunningTestServer;
  apiKeySignIn(key: string): Promise<Response>;
  oidcSignIn(person: FakeOidcPerson): Promise<Response>;
}

const alicePerson: FakeOidcPerson = {
  email: "alice@example.test",
  email_verified: true,
  name: "Alice From Provider",
  sub: "alice-subject",
};

/**
 * A private-team server with OIDC and API-key sign-in, three operator-issued
 * members, and one session row that belongs to a different installation.
 */
async function startMemberServer(): Promise<MemberServer> {
  const installation = await createTestInstallation();
  installations.push(installation);
  const provider = await startFakeOidcProvider();
  providers.push(provider);
  const clock = new MutableClock();
  // The private-team bootstrap key must exist before any member does.
  await (await startTestServer(installation, {
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    contentDomain: null,
  })).stop();
  const runtime = await createLocalRuntime({
    apiToken: installation.apiToken,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    contentDomain: null,
    dataDirectory: installation.dataDirectory,
  });
  const issue = (
    email: string,
    displayName: string,
    keyName: string,
    role: "administrator" | "member",
    expiresAt = "2099-01-01T00:00:00.000Z",
  ) => runtime.issueOperatorKey({displayName, email, expiresAt, keyName, role});
  let alice;
  let aliceShort;
  let bob;
  let admin;
  try {
    alice = await issue("alice@example.test", "Alice Example", "Alice laptop", "member");
    aliceShort = await issue(
      "alice@example.test",
      "Alice Example",
      "Alice short-lived",
      "member",
      new Date(clock.now().getTime() + 3_600_000).toISOString(),
    );
    bob = await issue("bob@example.test", "Bob Example", "Bob laptop", "member");
    admin = await issue("admin@example.test", "Admin Example", "Admin laptop", "administrator");
  } finally {
    await runtime.close();
  }

  const foreignToken = "foreign-installation-session-token-for-arc-005";
  const foreignCsrf = "foreign-installation-csrf-token-for-arc-005-test";
  const repository = new SqliteIdentityRepository(
    path.join(installation.dataDirectory, "artifact-server.db"),
  );
  try {
    const foreigner = await repository.admitMember({
      actor: installationOperatorActor,
      createdAt: clock.now().toISOString(),
      displayName: "Foreign administrator",
      email: "alice@example.test",
      id: "member_foreign_administrator",
      installationId: "foreign-installation",
      role: "administrator",
    });
    await repository.createApplicationSession({
      createdAt: clock.now().toISOString(),
      csrfDigest: digest(foreignCsrf),
      expiresAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
      id: "session_foreign_administrator",
      installationId: "foreign-installation",
      subject: {kind: "member", memberId: foreigner.id},
      tokenDigest: digest(foreignToken),
    });
  } finally {
    repository.close();
  }

  const server = await startTestServer(installation, {
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
      provider: createOidcProvider({
        clientId: provider.clientId,
        clientSecret: Redacted.make(provider.clientSecret),
        fetch: provider.fetch,
        issuer: provider.issuer,
        redirectUri,
        scopes: "openid email profile",
      }),
      unknownUsers: unknownOidcUserPolicies.reject,
    }),
    clock,
    contentDomain: null,
  });
  runningServers.push(server);

  const apiKeySignIn = (key: string) => fetch(`${server.baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey: key}),
    headers: {...sameOriginHeaders(server), "Content-Type": "application/json"},
    method: "POST",
  });
  const oidcSignIn = async (person: FakeOidcPerson) => {
    const started = await fetch(`${server.baseUrl}/auth/oidc/start`, {redirect: "manual"});
    const pending = cookiePair(started, "artifact_oidc");
    if (pending === undefined) throw new Error("The OIDC start set no pending cookie.");
    const approved = new URL(provider.approve(started.headers.get("location") ?? "", person));
    return fetch(`${server.baseUrl}/auth/oidc/callback${approved.search}`, {
      headers: {Cookie: pending},
      redirect: "manual",
    });
  };
  const adminSignIn = await apiKeySignIn(admin.issued.token);
  expect(adminSignIn.status).toBe(204);
  const projects = await fetch(`${server.baseUrl}/api/v1/projects`, {
    headers: bearerCredential(bob.issued.token),
  });
  const projectId = projectsSchema.parse(await projects.json()).projects[0]?.id;
  if (projectId === undefined) throw new Error("The installation has no project.");

  return {
    admin: {cookies: browserCookies(adminSignIn)},
    alice: {id: alice.member.id, key: alice.issued.token, keyId: alice.issued.apiKey.id},
    aliceShortKey: aliceShort.issued.token,
    apiKeySignIn,
    bob: {id: bob.member.id, key: bob.issued.token},
    clock,
    foreignSession: {
      csrf: foreignCsrf,
      header: `artifact_session=${foreignToken}; artifact_csrf=${foreignCsrf}`,
    },
    foreignSessionToken: foreignToken,
    oidcSignIn,
    projectId,
    server,
  };
}

describe("one principal model across sign-in methods", {timeout: 90_000}, () => {
  test("ARC-005-B: a member resolves to the same principal and gets the same decisions by bearer key, key session, OIDC session, and MCP", async () => {
    const member = await startMemberServer();
    const {server, projectId} = member;
    const keySession = browserCookies(await member.apiKeySignIn(member.alice.key));
    const oidcSession = browserCookies(await member.oidcSignIn(alicePerson));
    const bobClient = httpClient(server, projectId, bearerCredential(member.bob.key));

    const httpCredentials = {
      bearer: bearerCredential(member.alice.key),
      keySession: cookieCredential(server, keySession),
      oidcSession: cookieCredential(server, oidcSession),
    };
    const clients = {
      bearer: httpClient(server, projectId, httpCredentials.bearer),
      keySession: httpClient(server, projectId, httpCredentials.keySession),
      mcp: mcpClient(server, projectId, member.alice.key),
      oidcSession: httpClient(server, projectId, httpCredentials.oidcSession),
    };

    // A member reads and republishes any work, manages only their own
    // artifacts, and never administers the installation.
    const memberDecisions: Decisions = {
      changeOtherAccess: "denied",
      changeOwnAccess: "allowed",
      createProject: "denied",
      readOther: "allowed",
    };
    const results = Object.fromEntries(await Promise.all(Object.entries(clients).map(
      async ([method, client]) =>
        [method, await decide(client, bobClient.publish, `Alice ${method}`)] as const,
    )));
    expect(Object.fromEntries(Object.entries(results).map(([method, result]) =>
      [method, result.decisions]))).toEqual({
      bearer: memberDecisions,
      keySession: memberDecisions,
      mcp: memberDecisions,
      oidcSession: memberDecisions,
    });
    const memberListing = await Promise.all(Object.values(httpCredentials).map(async (credential) =>
      (await fetch(`${server.baseUrl}/api/v1/members`, {headers: credential})).status));
    expect(memberListing).toEqual([403, 403, 403]);

    // Every method names the same member, kind, role, and installation.
    const shared = {
      id: member.alice.id,
      installationId: "local",
      kind: "human",
      membershipRole: "member",
    };
    // A bearer key stays delegated by the operator with its own capabilities;
    // signing that key into a browser makes it the member's direct session.
    const delegated: ResolvedPrincipal = {
      ...shared,
      authorizedByPrincipalId: operatorPrincipalId,
      capabilities: memberKeyCapabilities,
      displayName: "Alice laptop",
    };
    const direct: ResolvedPrincipal = {
      ...shared,
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Alice Example",
    };
    expect(await readPrincipal(server, httpCredentials.bearer)).toEqual(delegated);
    expect(await readPrincipal(server, httpCredentials.keySession)).toEqual(direct);
    expect(await readPrincipal(server, httpCredentials.oidcSession)).toEqual(direct);
    // MCP has no session readback, so its principal shows in what it wrote.
    const writers = Object.fromEntries(Object.entries(results).map(([method, {own}]) => [
      method,
      {owner: own.ownerId, publisher: own.publisherId, publisherName: own.publisherName},
    ]));
    expect(writers).toEqual({
      bearer: {owner: shared.id, publisher: shared.id, publisherName: delegated.displayName},
      keySession: {owner: shared.id, publisher: shared.id, publisherName: direct.displayName},
      mcp: {owner: shared.id, publisher: shared.id, publisherName: delegated.displayName},
      oidcSession: {owner: shared.id, publisher: shared.id, publisherName: direct.displayName},
    });

    // A local-owner server: its token is one principal over HTTP and MCP.
    const local = await createTestInstallation();
    installations.push(local);
    const localServer = await startTestServer(local, {contentDomain: null});
    runningServers.push(localServer);
    const localToken = bearerCredential(local.apiToken);
    const localProjects = await fetch(`${localServer.baseUrl}/api/v1/projects`, {headers: localToken});
    const localProjectId = projectsSchema.parse(await localProjects.json()).projects[0]?.id ?? "";
    const browserToken = await issueLocalBrowserLogin(localServer, local);
    const ownerLogin = await fetch(
      `${localServer.baseUrl}/auth/local?token=${browserToken}`,
      {redirect: "manual"},
    );
    const ownerSession = cookieCredential(localServer, browserCookies(ownerLogin));
    const ownerClient = httpClient(localServer, localProjectId, ownerSession);
    const localClients = {
      bearer: httpClient(localServer, localProjectId, localToken),
      mcp: mcpClient(localServer, localProjectId, local.apiToken),
    };
    const localOwnerDecisions: Decisions = {
      changeOtherAccess: "allowed",
      changeOwnAccess: "allowed",
      createProject: "allowed",
      readOther: "allowed",
    };
    const bearerResult = await decide(localClients.bearer, ownerClient.publish, "Local bearer");
    const mcpResult = await decide(localClients.mcp, ownerClient.publish, "Local MCP");
    expect([bearerResult.decisions, mcpResult.decisions])
      .toEqual([localOwnerDecisions, localOwnerDecisions]);
    const localPrincipal = await readPrincipal(localServer, localToken);
    expect(localPrincipal).toMatchObject({id: "local-api-token", kind: "service"});
    // The local browser session is the local administrator member, a separate principal.
    const ownerPrincipal = await readPrincipal(localServer, ownerSession);
    expect(ownerPrincipal).toMatchObject({
      authorizedByPrincipalId: null,
      kind: "human",
      membershipRole: "administrator",
    });
    expect(ownerPrincipal.id).not.toBe(localPrincipal.id);
    expect([bearerResult.own.publisherId, mcpResult.own.publisherId])
      .toEqual([localPrincipal.id, localPrincipal.id]);
  });

  test("ARC-005-F: forged headers, body fields, foreign cookies, and expired or revoked credentials never resolve to another principal", async () => {
    const member = await startMemberServer();
    const {server, projectId} = member;
    const aliceBearer = bearerCredential(member.alice.key);
    const aliceOidc = browserCookies(await member.oidcSignIn(alicePerson));
    const aliceKeySession = browserCookies(await member.apiKeySignIn(member.alice.key));
    const aliceShortSession = browserCookies(await member.apiKeySignIn(member.aliceShortKey));
    const bobArtifact = await httpClient(server, projectId, bearerCredential(member.bob.key))
      .publish("Bob private");
    const baseline = {
      bearer: await readPrincipal(server, aliceBearer),
      oidc: await readPrincipal(server, cookieCredential(server, aliceOidc)),
    };
    expect(baseline.oidc.id).toBe(member.alice.id);
    expect(await Promise.all([aliceKeySession, aliceShortSession].map((cookies) =>
      readPrincipal(server, cookieCredential(server, cookies))))).toEqual([baseline.oidc, baseline.oidc]);

    const forgedHeaders = {
      "X-Forwarded-Email": "admin@example.test",
      "X-Forwarded-User": "admin@example.test",
      "X-Installation-Id": "foreign-installation",
      "X-Principal": JSON.stringify({id: member.bob.id, membershipRole: "administrator"}),
      "X-Principal-Id": member.bob.id,
      "X-Remote-User": "admin@example.test",
      "X-User": member.bob.id,
    };
    // Identity headers alone are no credential.
    expect(await sessionStatus(server, forgedHeaders)).toBe(401);
    const anonymousMcp = await fetch(`${server.baseUrl}/mcp`, {
      body: "{}",
      headers: {...forgedHeaders, Accept: "application/json, text/event-stream", "Content-Type": "application/json"},
      method: "POST",
    });
    expect(anonymousMcp.status).toBe(401);
    // Beside a real credential they change nothing it resolves to or may do.
    const forgedCalls = await Promise.all([aliceBearer, cookieCredential(server, aliceOidc)]
      .map(async (credential, index) => {
        const forged = {...credential, ...forgedHeaders};
        const client = httpClient(server, projectId, forged);
        return {
          change: await client.changeAccess(bobArtifact),
          create: await client.createProject(`Forged ${index}`),
          principal: await readPrincipal(server, forged),
        };
      }));
    expect(forgedCalls).toEqual([
      {change: "denied", create: "denied", principal: baseline.bearer},
      {change: "denied", create: "denied", principal: baseline.oidc},
    ]);
    // A broken bearer beside a valid administrator cookie does not fall back.
    expect(await sessionStatus(server, {
      ...cookieCredential(server, member.admin.cookies),
      Authorization: "Bearer not-a-key",
    })).toBe(401);

    // A body naming another principal is not an identity.
    const namedOther: ClaimedPrincipalFields = {
      owner: {principalId: member.bob.id},
      principal: {id: member.bob.id, kind: "human", membershipRole: "administrator"},
      principalId: member.bob.id,
    };
    expect(await Promise.all([aliceBearer, cookieCredential(server, aliceOidc)].map((credential) =>
      httpClient(server, projectId, credential).changeAccess(bobArtifact, namedOther))))
      .toEqual(["denied", "denied"]);
    // MCP tool input is strict, so the same fields never reach policy at all.
    expect(await mcpClient(server, projectId, member.alice.key).changeAccess(bobArtifact, namedOther))
      .toMatch(/Unrecognized keys: "owner", "principal", "principalId"/u);

    // A session row from another installation in the same database is no session here.
    expect(await sessionStatus(server, cookieCredential(server, member.foreignSession))).toBe(401);
    expect((await callTool(server, member.foreignSessionToken, "project_list", {})).status).toBe(401);

    // A revoked key fails as a bearer, over MCP, as its browser session, and
    // at sign-in; the member's own OIDC session is not affected.
    const revoked = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${member.alice.keyId}/revoke`,
      {headers: cookieCredential(server, member.admin.cookies), method: "POST"},
    );
    expect(revoked.status).toBe(200);
    expect(await sessionStatus(server, aliceBearer)).toBe(401);
    expect((await callTool(server, member.alice.key, "project_list", {})).status).toBe(401);
    expect(await sessionStatus(server, cookieCredential(server, aliceKeySession))).toBe(401);
    expect((await member.apiKeySignIn(member.alice.key)).status).toBe(401);
    expect(await readPrincipal(server, cookieCredential(server, aliceOidc))).toEqual(baseline.oidc);

    // A signed-out session is gone.
    const logout = await fetch(`${server.baseUrl}/api/v1/session/logout`, {
      headers: cookieCredential(server, aliceOidc),
      method: "POST",
    });
    expect(logout.ok).toBe(true);
    expect(await sessionStatus(server, cookieCredential(server, aliceOidc))).toBe(401);

    // Past their expiry a session and a key resolve to no one.
    const lateOidc = browserCookies(await member.oidcSignIn(alicePerson));
    expect(await readPrincipal(server, cookieCredential(server, lateOidc))).toEqual(baseline.oidc);
    const shortBearer = bearerCredential(member.aliceShortKey);
    expect((await readPrincipal(server, shortBearer)).id).toBe(member.alice.id);
    member.clock.advance(13 * 3_600_000);
    expect(await sessionStatus(server, cookieCredential(server, lateOidc))).toBe(401);
    expect(await sessionStatus(server, shortBearer)).toBe(401);
    expect((await callTool(server, member.aliceShortKey, "project_list", {})).status).toBe(401);
    expect(await sessionStatus(server, cookieCredential(server, aliceShortSession))).toBe(401);
  });
});
