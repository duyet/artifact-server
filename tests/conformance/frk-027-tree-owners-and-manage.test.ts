import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {issueApiKey, MutableClock} from "../support/agent-dispatch.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const bootstrapAdministratorEmail = "administrator@example.test";

const manageHandleSchema = z.object({
  artifactId: z.string(),
  currentVersionId: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
}).strict();
const treeSchema = z.object({
  artifacts: z.array(z.object({
    access: z.enum(["account_required", "public_link"]),
    manage: manageHandleSchema.nullable(),
    mine: z.boolean(),
    name: z.string(),
    owner: z.string().nullable(),
    visibility: z.enum(["private", "public", "unlisted"]),
  }).loose()),
  collapsedFolders: z.array(z.string()),
  truncated: z.boolean(),
  viewer: z.object({name: z.string()}).strict().nullable(),
}).loose();
type Tree = z.infer<typeof treeSchema>;
type TreeRow = Tree["artifacts"][number];

interface BrowserCookies {
  readonly csrf: string;
  readonly header: string;
}

function sameOriginHeaders(server: RunningTestServer) {
  return {
    "Content-Type": "application/json",
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function cookieMutation(
  server: RunningTestServer,
  cookies: BrowserCookies,
  idempotencyKey: string,
) {
  return {
    ...sameOriginHeaders(server),
    Cookie: cookies.header,
    "Idempotency-Key": idempotencyKey,
    "X-CSRF-Token": cookies.csrf,
  };
}

/** Sign a browser in with one API key, as the no-login sign-in form does. */
async function signIn(
  server: RunningTestServer,
  apiKey: string,
): Promise<BrowserCookies> {
  const response = await fetch(`${server.baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers: sameOriginHeaders(server),
    method: "POST",
  });
  expect(response.status).toBe(204);
  const pairs = response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "");
  const session = pairs.find((pair) => pair.startsWith("artifact_session="));
  const csrf = pairs.find((pair) => pair.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The sign-in response did not set both application cookies.");
  }
  return {csrf: csrf.slice("artifact_csrf=".length), header: `${session}; ${csrf}`};
}

async function fetchTree(
  server: RunningTestServer,
  headers: Readonly<Record<string, string>> = {},
): Promise<{readonly response: Response; readonly text: string; readonly tree: Tree}> {
  const response = await fetch(`${server.baseUrl}/api/v1/public/tree`, {headers});
  expect(response.status).toBe(200);
  // The body depends on the session, so no shared cache may keep it and no
  // cache may answer one viewer with another viewer's copy.
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("vary") ?? "").toContain("Cookie");
  const text = await response.text();
  return {response, text, tree: treeSchema.parse(JSON.parse(text))};
}

async function readTree(
  server: RunningTestServer,
  cookies: BrowserCookies | null = null,
): Promise<Tree> {
  return (await fetchTree(
    server,
    cookies === null ? {} : {Cookie: cookies.header},
  )).tree;
}

function row(tree: Tree, name: string): TreeRow {
  const found = tree.artifacts.find((artifact) => artifact.name === name);
  if (found === undefined) throw new Error(`The tree holds no artifact named ${name}.`);
  return found;
}

function manageHandle(tree: Tree, name: string) {
  const handle = row(tree, name).manage;
  if (handle === null) throw new Error(`${name} carries no manage handle.`);
  return handle;
}

describe("artifact tree owners and manage handles", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;

  const running = (): RunningTestServer => {
    if (server === undefined) throw new Error("The test server is not running.");
    return server;
  };

  /** Mint one member and its key, as `admin issue-key` does. */
  async function issueMemberKey(
    displayName: string,
    email: string,
    keyName: string,
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
        keyName,
        role,
      });
      return {memberId: member.id, token: issued.token};
    } finally {
      await runtime.close();
    }
  }

  /**
   * Alice owns one public and one private artifact. Carol, whose name and
   * key name are her email, owns one public and one unlisted artifact. Each
   * publish is a minute after the last, so newest first is a fixed order.
   */
  async function seed(): Promise<{
    readonly alice: string;
    readonly aliceMemberId: string;
    readonly administrator: string;
    readonly carol: string;
  }> {
    const aliceKey = await issueMemberKey("Alice Example", "alice@example.com", "Alice Example @ laptop");
    const alice = aliceKey.token;
    const carol = (await issueMemberKey("carol@example.com", "carol@example.com", "carol@example.com")).token;
    const {token: administrator} = await issueMemberKey(
      "Admin Example",
      "admin@example.test",
      "Admin Example",
      "administrator",
    );
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      clock,
      contentDomain: null,
    });
    const asAlice = {...installation, apiToken: alice};
    const asCarol = {...installation, apiToken: carol};
    await publishSite(running(), asAlice, {
      accessSetting: "public_link",
      name: "Alice public",
      path: "team/alice-public",
    });
    clock.advance(60_000);
    await publishSite(running(), asAlice, {
      accessSetting: "account_required",
      name: "Alice private",
      path: "team/alice-private",
    });
    clock.advance(60_000);
    await publishSite(running(), asCarol, {
      accessSetting: "public_link",
      name: "Carol report",
      path: "team/carol-report",
    });
    clock.advance(60_000);
    const unlisted = await publishSite(running(), asCarol, {
      accessSetting: "public_link",
      name: "Carol unlisted",
      path: "old/carol-unlisted",
    });
    const tagged = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${unlisted.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: unlisted.version.id,
          tags: ["unlisted", "archive"],
        }),
        headers: apiHeaders(installation, "frk-027-unlist-carol"),
        method: "PATCH",
      },
    );
    expect(tagged.status).toBe(200);
    return {administrator, alice, aliceMemberId: aliceKey.memberId, carol};
  }

  /** Every artifact name a session can list, across every project. */
  async function listedNames(cookies: BrowserCookies): Promise<readonly string[]> {
    const read = (path: string) =>
      fetch(`${running().baseUrl}${path}`, {headers: {Cookie: cookies.header}});
    const projects = z.object({projects: z.array(z.object({id: z.string()}))})
      .parse(await (await read("/api/v1/projects")).json()).projects;
    const pages = await Promise.all(projects.map(async (project) =>
      z.object({artifacts: z.array(z.object({artifact: z.object({name: z.string()})}))})
        .parse(await (await read(`/api/v1/artifacts?projectId=${project.id}&limit=100`)).json())
    ));
    return pages.flatMap((page) => page.artifacts.map((item) => item.artifact.name)).toSorted();
  }

  /** A key an administrator issues for one member, with the given scope. */
  async function issueMemberApiKey(
    administrator: BrowserCookies,
    memberId: string,
    capabilities: readonly string[],
    name: string,
  ): Promise<string> {
    const issued = await fetch(`${running().baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId,
        name,
      }),
      headers: cookieMutation(running(), administrator, `frk-027-key-${crypto.randomUUID()}`),
      method: "POST",
    });
    expect(issued.status).toBe(201);
    return z.object({token: z.string()}).parse(await issued.json()).token;
  }

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-26T08:00:00.000Z");
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

  test("FRK-027-B: anonymous rows name their owner and are public; a member reads every live artifact with visibility, mine, and a manage handle that changes it", async () => {
    const {administrator: administratorKey, alice} = await seed();

    const anonymous = await readTree(running());
    expect(anonymous.viewer).toBeNull();
    expect(anonymous.artifacts.map((artifact) => ({
      manage: artifact.manage,
      mine: artifact.mine,
      name: artifact.name,
      owner: artifact.owner,
      visibility: artifact.visibility,
    }))).toEqual([
      // Carol's stored name is her email, so the tree names no owner.
      {manage: null, mine: false, name: "Carol report", owner: null, visibility: "public"},
      {manage: null, mine: false, name: "Alice public", owner: "Alice Example @ laptop", visibility: "public"},
    ]);

    const cookies = await signIn(running(), alice);
    const member = await readTree(running(), cookies);
    expect(member.viewer).toEqual({name: "Alice Example"});
    // Every live artifact in every project, newest first, whatever its access
    // setting and tags, each with its real access and its visibility.
    expect(member.artifacts.map((artifact) => ({
      access: artifact.access,
      mine: artifact.mine,
      name: artifact.name,
      owner: artifact.owner,
      visibility: artifact.visibility,
    }))).toEqual([
      {access: "public_link", mine: false, name: "Carol unlisted", owner: null, visibility: "unlisted"},
      {access: "public_link", mine: false, name: "Carol report", owner: null, visibility: "public"},
      {access: "account_required", mine: true, name: "Alice private", owner: "Alice Example @ laptop", visibility: "private"},
      {access: "public_link", mine: true, name: "Alice public", owner: "Alice Example @ laptop", visibility: "public"},
    ]);
    // The tree shows a member nothing the authenticated listing would not:
    // the same artifacts as every project's GET /api/v1/artifacts.
    expect(member.artifacts.map((artifact) => artifact.name).toSorted())
      .toEqual(await listedNames(cookies));

    // A member may change the visibility of what they own, so only their
    // own rows carry a handle.
    expect(manageHandle(member, "Alice public").tags).toEqual([]);
    expect(manageHandle(member, "Alice private").tags).toEqual([]);
    expect(row(member, "Carol unlisted").manage).toBeNull();
    expect(row(member, "Carol report").manage).toBeNull();
    // An administrator may change any artifact, with its tags sorted.
    const administrator = await signIn(running(), administratorKey);
    const administratorTree = await readTree(running(), administrator);
    expect(manageHandle(administratorTree, "Carol unlisted").tags).toEqual(["archive", "unlisted"]);
    expect(administratorTree.artifacts.every((artifact) => artifact.manage !== null)).toBe(true);
    // A collapsed folder that holds only the unlisted artifact is named to
    // the member, who sees that artifact, and never to an anonymous reader.
    const collapsed = await fetch(`${running().baseUrl}/api/v1/folder-defaults`, {
      body: JSON.stringify({defaultState: "collapsed", path: "old"}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    expect(collapsed.status).toBe(200);
    expect((await readTree(running(), cookies)).collapsedFolders).toEqual(["old"]);
    expect((await readTree(running())).collapsedFolders).toEqual([]);

    // The handle carries exactly what the access API needs: the artifact,
    // its project, and the version the change is made against.
    const alicePublic = manageHandle(member, "Alice public");
    const madePrivate = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${alicePublic.artifactId}/access` +
        `?projectId=${alicePublic.projectId}`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: alicePublic.currentVersionId,
        }),
        headers: cookieMutation(running(), cookies, "frk-027-alice-private"),
        method: "PATCH",
      },
    );
    expect(madePrivate.status).toBe(200);

    // Listing an unlisted artifact again is a tags change that keeps every
    // other tag the handle carried.
    const carolUnlisted = manageHandle(administratorTree, "Carol unlisted");
    const listed = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${carolUnlisted.artifactId}/tags` +
        `?projectId=${carolUnlisted.projectId}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: carolUnlisted.currentVersionId,
          tags: carolUnlisted.tags.filter((tag) => tag !== "unlisted"),
        }),
        headers: cookieMutation(running(), administrator, "frk-027-carol-listed"),
        method: "PATCH",
      },
    );
    expect(listed.status).toBe(200);

    const changed = await readTree(running(), administrator);
    expect(row(changed, "Alice public")).toMatchObject({
      access: "account_required",
      visibility: "private",
    });
    expect(row(changed, "Carol unlisted")).toMatchObject({
      manage: {tags: ["archive"]},
      visibility: "public",
    });
    expect((await readTree(running())).artifacts.map((artifact) => artifact.name))
      .toEqual(["Carol unlisted", "Carol report"]);
  });

  test("FRK-027-F: anonymous reads hide private, unlisted, emails, and handles; a bad session reads as anonymous; a session that cannot manage gets no handle", async () => {
    const {administrator: administratorKey, alice, aliceMemberId} = await seed();

    const anonymous = await fetchTree(running());
    expect(anonymous.tree.viewer).toBeNull();
    expect(anonymous.tree.artifacts.map((artifact) => artifact.name))
      .toEqual(["Carol report", "Alice public"]);
    for (const artifact of anonymous.tree.artifacts) {
      expect(artifact).toMatchObject({manage: null, mine: false, visibility: "public"});
    }
    // No owner email reaches an anonymous reader anywhere in the body.
    expect(anonymous.text).not.toContain("@example.com");
    const anonymousNames = anonymous.tree.artifacts.map((artifact) => artifact.name);

    // An email display name stays hidden from members too.
    const cookies = await signIn(running(), alice);
    const member = await fetchTree(running(), {Cookie: cookies.header});
    expect(member.text).not.toContain("@example.com");

    // A malformed cookie, a well-formed unknown token, and a bearer header
    // with no cookie all read as anonymous with 200, never 401.
    const strangers = await Promise.all([
      {Cookie: "artifact_session=not a token"},
      {Cookie: `artifact_session=${"a".repeat(43)}`},
      {Authorization: `Bearer ${installation.apiToken}`},
    ].map((headers) => fetchTree(running(), headers)));
    for (const read of strangers) {
      expect(read.tree.viewer).toBeNull();
      expect(read.tree.artifacts.map((artifact) => artifact.name)).toEqual(anonymousNames);
      expect(read.tree.artifacts.every((artifact) => artifact.manage === null)).toBe(true);
    }

    // A revoked session reads as anonymous.
    const loggedOut = await fetch(`${running().baseUrl}/api/v1/session/logout`, {
      headers: cookieMutation(running(), cookies, "frk-027-logout"),
      method: "POST",
    });
    expect(loggedOut.status).toBe(204);
    const revoked = await readTree(running(), cookies);
    expect(revoked.viewer).toBeNull();
    expect(revoked.artifacts.map((artifact) => artifact.name)).toEqual(anonymousNames);

    // An expired session reads as anonymous. Sessions last 12 hours.
    const expiring = await signIn(running(), alice);
    expect((await readTree(running(), expiring)).viewer).toEqual({name: "Alice Example"});
    clock.advance(13 * 60 * 60 * 1_000);
    const expired = await readTree(running(), expiring);
    expect(expired.viewer).toBeNull();
    expect(expired.artifacts.map((artifact) => artifact.name)).toEqual(anonymousNames);

    // A key that may read every artifact but not change settings lists the
    // private and unlisted ones with no handle, and the access API agrees.
    const administrator = await signIn(running(), administratorKey);
    const reader = await signIn(
      running(),
      await issueApiKey(running(), administrator, ["artifact:read"], "Reader"),
    );
    const readerTree = await readTree(running(), reader);
    expect(readerTree.artifacts.map((artifact) => artifact.name).toSorted())
      .toEqual(await listedNames(reader));
    expect(readerTree.viewer).toEqual({name: "Reader"});
    expect(readerTree.artifacts.map((artifact) => artifact.visibility))
      .toEqual(["unlisted", "public", "private", "public"]);
    expect(readerTree.artifacts.every((artifact) =>
      artifact.manage === null && !artifact.mine
    )).toBe(true);
    const administratorHandle = manageHandle(
      await readTree(running(), administrator),
      "Alice private",
    );
    const refused = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${administratorHandle.artifactId}/access` +
        `?projectId=${administratorHandle.projectId}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: administratorHandle.currentVersionId,
        }),
        headers: cookieMutation(running(), reader, "frk-027-reader-refused"),
        method: "PATCH",
      },
    );
    expect(refused.status).toBe(403);

    // A key on Alice's own principal that may only read is not her: it sees
    // her artifacts as hers, but gets no handle on them.
    const ownerReader = await signIn(
      running(),
      await issueMemberApiKey(administrator, aliceMemberId, ["artifact:read"], "Alice reader"),
    );
    const ownerReaderTree = await readTree(running(), ownerReader);
    expect(row(ownerReaderTree, "Alice private")).toMatchObject({manage: null, mine: true});
    expect(row(ownerReaderTree, "Alice public")).toMatchObject({manage: null, mine: true});
    expect(ownerReaderTree.artifacts.every((artifact) => artifact.manage === null)).toBe(true);
    const ownPrivate = administratorHandle;
    const ownRefused = await fetch(
      `${running().baseUrl}/api/v1/artifacts/${ownPrivate.artifactId}/access` +
        `?projectId=${ownPrivate.projectId}`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: ownPrivate.currentVersionId,
        }),
        headers: cookieMutation(running(), ownerReader, "frk-027-owner-reader-refused"),
        method: "PATCH",
      },
    );
    expect(ownRefused.status).toBe(403);

    // A key that may not list artifacts reads only the anonymous set.
    const commenter = await signIn(
      running(),
      await issueApiKey(running(), administrator, ["comment:write"], "Commenter"),
    );
    const commenterTree = await readTree(running(), commenter);
    expect(commenterTree.artifacts.map((artifact) => artifact.name)).toEqual(anonymousNames);
    expect(commenterTree.artifacts.every((artifact) => artifact.manage === null)).toBe(true);
  });
});
