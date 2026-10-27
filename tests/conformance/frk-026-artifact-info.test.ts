import {createHash} from "node:crypto";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const day = 24 * 60 * 60 * 1_000;

const infoSchema = z.object({
  artifactId: z.string(),
  canManage: z.boolean(),
  name: z.string(),
  owner: z.object({displayName: z.string().nullable()}).strict(),
  updatedAt: z.iso.datetime(),
  version: z.object({id: z.string(), number: z.number().int().positive()}).strict(),
  views: z.object({
    daily: z.array(z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      views: z.number().int().positive(),
    }).strict()),
    last30Days: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  visibility: z.enum(["private", "public", "unlisted"]),
  windowDays: z.literal(30),
}).strict();
const artifactSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    tags: z.array(z.string()),
  }).loose(),
}).loose();
const errorSchema = z.object({error: z.object({code: z.string()}).loose()});
const memberSchema = z.object({member: z.object({id: z.string()}).loose()});
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});

/** One caller as the HTTP boundary sees it: a bearer key or browser cookies. */
type Caller =
  | {readonly kind: "bearer"; readonly token: string}
  | {readonly csrf: string; readonly kind: "session"; readonly cookie: string};

describe("artifact info and the visibility permission", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let started: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await started?.stop();
    started = null;
    await removeTestInstallation(installation);
  });

  // MCP checks its bearer expiry against the wall clock, so a test that calls
  // MCP keeps the server clock at the present.
  async function start(at: MutableClock): Promise<void> {
    clock = at;
    server = await startTestServer(installation, {clock, contentDomain: null});
    started = server;
  }

  const operator = (): Caller => ({kind: "bearer", token: installation.apiToken});

  function headersFor(caller: Caller, idempotencyKey?: string): Headers {
    const headers = new Headers({"Content-Type": "application/json"});
    if (caller.kind === "bearer") {
      headers.set("Authorization", `Bearer ${caller.token}`);
    } else {
      headers.set("Cookie", caller.cookie);
      headers.set("Origin", server.baseUrl);
      headers.set("Sec-Fetch-Mode", "cors");
      headers.set("Sec-Fetch-Site", "same-origin");
      headers.set("X-CSRF-Token", caller.csrf);
    }
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    return headers;
  }

  function readInfo(caller: Caller | null, artifactId: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}/info`, {
      headers: caller === null ? {} : headersFor(caller),
    });
  }

  async function info(caller: Caller, artifactId: string) {
    const response = await readInfo(caller, artifactId);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return {body: infoSchema.parse(body), text: JSON.stringify(body)};
  }

  function patch(
    caller: Caller,
    published: PublishResponse,
    route: "access" | "tags",
    body:
      | {readonly accessSetting: "account_required" | "public_link"}
      | {readonly tags: readonly string[]},
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/${route}`, {
      body: JSON.stringify({expectedCurrentVersionId: published.version.id, ...body}),
      headers: headersFor(caller, crypto.randomUUID()),
      method: "PATCH",
    });
  }

  async function readBack(artifactId: string) {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
      headers: headersFor(operator()),
    });
    expect(response.status).toBe(200);
    return artifactSchema.parse(await response.json()).artifact;
  }

  async function view(published: PublishResponse, times: number): Promise<void> {
    const responses = await Promise.all(Array.from(
      {length: times},
      () => fetch(`${published.links.version}index.html`),
    ));
    expect(responses.map((response) => response.status))
      .toEqual(responses.map(() => 200));
    await server.flushArtifactViews();
  }

  async function publishAs(token: string, name: string, tags: readonly string[] = []) {
    const published = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting: "public_link",
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: crypto.randomUUID(),
      name,
      tags,
    });
    expect(published.response.status).toBe(201);
    return published.body;
  }

  /** Admit one member and give it a key that may create and read but not manage. */
  async function memberWithKey(email: string) {
    const administrator = await signInAdministrator(server, installation);
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Example Member", email, role: "member"}),
      headers: headersFor({
        cookie: administrator.header,
        csrf: administrator.csrf,
        kind: "session",
      }),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    const token = await issueMemberKey(
      administrator,
      memberId,
      ["artifact:create", "artifact:read"],
      "Example member laptop",
    );
    return {administrator, memberId, token};
  }

  /** Another key an administrator issues for the same member. */
  async function issueMemberKey(
    administrator: Awaited<ReturnType<typeof signInAdministrator>>,
    memberId: string,
    capabilities: readonly string[],
    name: string,
  ): Promise<string> {
    const issued = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId,
        name,
      }),
      headers: headersFor({
        cookie: administrator.header,
        csrf: administrator.csrf,
        kind: "session",
      }),
      method: "POST",
    });
    expect(issued.status).toBe(201);
    return z.object({token: z.string()}).parse(await issued.json()).token;
  }

  /** A direct human session for a member who is not an administrator. */
  async function memberSession(memberId: string): Promise<Caller> {
    const repository = new SqliteIdentityRepository(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    const token = "frk-026-member-session-token-for-visibility-tests";
    const csrf = "frk-026-member-csrf-token-for-visibility-tests";
    try {
      await repository.createApplicationSession({
        createdAt: clock.now().toISOString(),
        csrfDigest: digest(csrf),
        expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
        id: "session_frk_026_member",
        installationId: "local",
        subject: {kind: "member", memberId},
        tokenDigest: digest(token),
      });
    } finally {
      repository.close();
    }
    return {
      cookie: `artifact_session=${token}; artifact_csrf=${csrf}`,
      csrf,
      kind: "session",
    };
  }

  test("FRK-026-B: info reads the owner, current version, visibility, update time, exact views, and canManage, and owners and administrators change visibility", async () => {
    await start(new MutableClock("2026-08-01T10:00:00.000Z"));
    const first = await publishAs(installation.apiToken, "Quarterly report");
    // Outside the 30-day window but inside the total.
    await view(first, 4);
    clock.advance(80 * day); // 2026-10-20
    await view(first, 3);
    clock.advance(2 * day); // 2026-10-22
    const second = await publishVersion(server, installation, {
      artifactId: first.artifact.id,
      content: "<!doctype html><title>Quarterly report, revised</title>",
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(second.response.status).toBe(201);
    await view(second.body, 2);

    const read = await info(operator(), first.artifact.id);
    expect(read.body).toEqual({
      artifactId: first.artifact.id,
      canManage: true,
      name: "Quarterly report",
      owner: {displayName: first.artifact.owner.displayName},
      updatedAt: "2026-10-22T10:00:00.000Z",
      version: {id: second.body.version.id, number: 2},
      views: {
        daily: [
          {day: "2026-10-20", views: 3},
          {day: "2026-10-22", views: 2},
        ],
        last30Days: 5,
        total: 9,
      },
      visibility: "public",
      windowDays: 30,
    });
    expect(read.body.updatedAt).toBe(second.body.version.createdAt);

    expect((await patch(operator(), second.body, "tags", {tags: ["unlisted"]})).status)
      .toBe(200);
    expect((await info(operator(), first.artifact.id)).body.visibility)
      .toBe("unlisted");
    expect((await patch(operator(), second.body, "access", {
      accessSetting: "account_required",
    })).status).toBe(200);
    expect((await info(operator(), first.artifact.id)).body.visibility)
      .toBe("private");

    // A member's own key owns what it published, without any manage capability.
    const member = await memberWithKey("member@example.test");
    const memberKey: Caller = {kind: "bearer", token: member.token};
    const owned = await publishAs(member.token, "Member notes");
    expect(owned.artifact.owner.principalId).toBe(member.memberId);
    expect((await info(memberKey, owned.artifact.id)).body).toMatchObject({
      canManage: true,
      owner: {displayName: "Example member laptop"},
      visibility: "public",
    });
    expect((await patch(memberKey, owned, "tags", {tags: ["unlisted"]})).status)
      .toBe(200);
    expect((await patch(memberKey, owned, "access", {
      accessSetting: "account_required",
    })).status).toBe(200);
    expect(await readBack(owned.artifact.id)).toMatchObject({
      accessSetting: "account_required",
      tags: ["unlisted"],
    });
    expect((await patch(memberKey, owned, "tags", {tags: []})).status).toBe(200);
    expect((await readBack(owned.artifact.id)).tags).toEqual([]);

    // An administrator session changes an artifact it does not own.
    const administrator: Caller = {
      cookie: member.administrator.header,
      csrf: member.administrator.csrf,
      kind: "session",
    };
    expect((await info(administrator, owned.artifact.id)).body.canManage).toBe(true);
    expect((await patch(administrator, owned, "access", {
      accessSetting: "public_link",
    })).status).toBe(200);
    expect((await patch(administrator, owned, "tags", {tags: ["unlisted"]})).status)
      .toBe(200);
    expect(await readBack(owned.artifact.id)).toMatchObject({
      accessSetting: "public_link",
      tags: ["unlisted"],
    });
  }, 60_000);

  test("FRK-026-F: a reader who neither owns nor administers sees canManage false and cannot change visibility over HTTP or MCP, and info refuses unknown artifacts, missing credentials, and keys without read", async () => {
    await start(new MutableClock());
    const member = await memberWithKey("member@example.test");
    const memberKey: Caller = {kind: "bearer", token: member.token};
    const owned = await publishAs(member.token, "Member notes");
    const theirs = await publishAs(installation.apiToken, "Operator report", ["release"]);

    const keyRead = await info(memberKey, theirs.artifact.id);
    expect(keyRead.body.canManage).toBe(false);
    const refusedAccess = await patch(memberKey, theirs, "access", {
      accessSetting: "account_required",
    });
    expect(refusedAccess.status).toBe(403);
    expect(errorSchema.parse(await refusedAccess.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    const refusedHide = await patch(memberKey, theirs, "tags", {
      tags: ["release", "unlisted"],
    });
    expect(refusedHide.status).toBe(403);
    expect(errorSchema.parse(await refusedHide.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    // A different spelling of the tag normalizes to the same visibility change.
    expect((await patch(memberKey, theirs, "tags", {
      tags: ["release", "Unlisted"],
    })).status).toBe(403);
    expect(await readBack(theirs.artifact.id)).toMatchObject({
      accessSetting: "public_link",
      tags: ["release"],
    });

    // A direct human member is not an administrator and does not own it.
    const human = await memberSession(member.memberId);
    expect((await info(human, theirs.artifact.id)).body.canManage).toBe(false);
    expect((await patch(human, theirs, "access", {
      accessSetting: "account_required",
    })).status).toBe(403);
    expect((await patch(human, theirs, "tags", {
      tags: ["release", "unlisted"],
    })).status).toBe(403);
    expect(await readBack(theirs.artifact.id)).toMatchObject({
      accessSetting: "public_link",
      tags: ["release"],
    });
    // The same session still edits tags that leave visibility alone.
    expect((await patch(human, theirs, "tags", {tags: ["draft", "release"]})).status)
      .toBe(200);
    expect((await readBack(theirs.artifact.id)).tags).toEqual(["draft", "release"]);

    // Removing the tag is a visibility change too.
    expect((await patch(operator(), theirs, "tags", {
      tags: ["draft", "release", "unlisted"],
    })).status).toBe(200);
    expect((await patch(human, theirs, "tags", {tags: ["draft", "release"]})).status)
      .toBe(403);
    expect((await readBack(theirs.artifact.id)).tags)
      .toEqual(["draft", "release", "unlisted"]);

    const viaMcp = await callTool(member.token, "artifact_set_visibility", {
      accessSetting: "account_required",
      artifactId: theirs.artifact.id,
      expectedCurrentVersionId: theirs.version.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(viaMcp.isError).toBe(true);
    expect(errorSchema.parse(viaMcp.structuredContent).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await readBack(theirs.artifact.id)).accessSetting).toBe("public_link");

    // A key on the owner's own principal that may only read does not own the
    // artifact: the owner match counts only for a key that may create.
    const readOnly = await issueMemberKey(
      member.administrator,
      member.memberId,
      ["artifact:read"],
      "Example member reader",
    );
    const readOnlyKey: Caller = {kind: "bearer", token: readOnly};
    const hidden = await publishAs(member.token, "Member hidden notes", ["unlisted"]);
    expect((await info(readOnlyKey, owned.artifact.id)).body.canManage).toBe(false);
    expect((await patch(readOnlyKey, owned, "access", {
      accessSetting: "account_required",
    })).status).toBe(403);
    expect((await patch(readOnlyKey, owned, "tags", {tags: ["unlisted"]})).status)
      .toBe(403);
    expect((await patch(readOnlyKey, hidden, "tags", {tags: []})).status).toBe(403);
    const ownViaMcp = await callTool(readOnly, "artifact_set_visibility", {
      accessSetting: "account_required",
      artifactId: owned.artifact.id,
      expectedCurrentVersionId: owned.version.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(ownViaMcp.isError).toBe(true);
    expect(errorSchema.parse(ownViaMcp.structuredContent).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect(await readBack(owned.artifact.id)).toMatchObject({
      accessSetting: "public_link",
      tags: [],
    });
    expect((await readBack(hidden.artifact.id)).tags).toEqual(["unlisted"]);

    expect((await readInfo(operator(), "art_00000000-0000-4000-8000-000000000000")).status)
      .toBe(404);
    expect((await readInfo(null, theirs.artifact.id)).status).toBe(401);
    const agentOnly = await issueApiKey(
      server,
      member.administrator,
      ["agent:connect"],
      "Agent only",
    );
    expect((await readInfo({kind: "bearer", token: agentOnly}, theirs.artifact.id)).status)
      .toBe(403);

    const ownRead = await info(memberKey, owned.artifact.id);
    expect(ownRead.text).not.toContain("member@example.test");
    expect(ownRead.text).not.toContain(member.memberId);
    expect(keyRead.text).not.toContain(theirs.artifact.owner.principalId);
    expect(keyRead.text).not.toContain("administrator@example.test");

    // A display name that is an email is withheld, even from its own owner.
    const emailNamedKey = await issueMemberKey(
      member.administrator,
      member.memberId,
      ["artifact:create", "artifact:read"],
      "member@example.test",
    );
    const emailNamed = await publishAs(emailNamedKey, "Email named notes");
    expect(emailNamed.artifact.owner.displayName).toBe("member@example.test");
    const emailNamedRead = await info(memberKey, emailNamed.artifact.id);
    expect(emailNamedRead.body.owner).toEqual({displayName: null});
    expect(emailNamedRead.text).not.toContain("@");
  }, 60_000);

  async function callTool(
    token: string,
    name: string,
    toolArguments: Readonly<Record<string, string>>,
  ) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
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
    expect(response.status).toBe(200);
    return toolResultSchema.parse(await response.json()).result;
  }
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
