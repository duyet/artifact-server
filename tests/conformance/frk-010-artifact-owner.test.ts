import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";

const requestFrk010OwnerMine = "frk-010-owner-mine";
const requestFrk010OwnerTheirs = "frk-010-owner-theirs";
const requestFrk010OwnerMineV2 = "frk-010-owner-mine-v2";
const requestFrk010OwnerOwnerSecond = "frk-010-owner-owner-second";

const ownerSchema = z.object({
  displayName: z.string().nullable(),
  principalId: z.string(),
}).strict();
const listSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string(), name: z.string(), owner: ownerSchema}),
    currentVersionNumber: z.number().int().positive(),
    owner: ownerSchema,
    updatedAt: z.string(),
    versionCount: z.number().int().positive(),
    views: z.object({
      last30Days: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }).strict(),
  })),
  nextCursor: z.string().nullable(),
});
const detailSchema = z.object({
  artifact: z.object({owner: ownerSchema}),
  current: z.object({
    version: z.object({
      publisherDisplayName: z.string().nullable(),
      publisherPrincipalId: z.string(),
    }),
  }),
});
const sessionSchema = z.object({
  principal: z.object({displayName: z.string(), id: z.string()}),
});

const today = "2026-10-17";
const todayInstant = new Date(`${today}T09:00:00.000Z`);

describe("artifact owner and publisher name", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await removeTestInstallation(installation);
  });

  async function start(): Promise<RunningTestServer> {
    server = await startTestServer(installation, {
      clock: {now: () => todayInstant},
      contentDomain: null,
    });
    return server;
  }

  test("FRK-010-B: the creator owns an artifact, each version names its publisher, and the list carries owner, last change, version number, and views", async () => {
    const running = await start();
    const owner = await readPrincipal(running, installation.apiToken);
    const releaseBot = await serviceKey(running, installation, "Release bot");
    const mine = await publishNew(running, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Mine</title>",
      idempotencyKey: requestFrk010OwnerMine,
      name: "Mine",
    });
    const theirs = await publishNew(running, asPrincipal(installation, releaseBot), {
      accessSetting: "public_link",
      content: "<!doctype html><title>Theirs</title>",
      idempotencyKey: requestFrk010OwnerTheirs,
      name: "Theirs",
    });
    const bot = await readPrincipal(running, releaseBot);
    expect(mine.body.artifact).toMatchObject({
      owner: {displayName: owner.displayName, principalId: owner.id},
    });
    expect(mine.body.version).toMatchObject({
      publisherDisplayName: owner.displayName,
      publisherPrincipalId: owner.id,
    });
    expect(theirs.body.artifact).toMatchObject({
      owner: {displayName: "Release bot", principalId: bot.id},
    });

    // A second publisher's version names that publisher and leaves the
    // artifact's owner alone.
    const second = await publishVersion(running, asPrincipal(installation, releaseBot), {
      artifactId: mine.body.artifact.id,
      content: "<!doctype html><title>Mine, edited by the bot</title>",
      expectedCurrentVersionId: mine.body.version.id,
      idempotencyKey: requestFrk010OwnerMineV2,
    });
    expect(second.response.status).toBe(201);
    const details = await getJson(
      running,
      installation.apiToken,
      `/api/v1/artifacts/${mine.body.artifact.id}`,
      detailSchema,
    );
    expect(details.artifact.owner).toEqual({
      displayName: owner.displayName,
      principalId: owner.id,
    });
    expect(details.current.version).toMatchObject({
      publisherDisplayName: "Release bot",
      publisherPrincipalId: bot.id,
    });

    // Two entry-document reads of the first artifact land as two views.
    expect((await fetch(`${second.body.links.version}index.html`)).status)
      .toBe(200);
    expect((await fetch(`${second.body.links.version}index.html`)).status)
      .toBe(200);
    await running.flushArtifactViews();

    const all = await list(running, installation.apiToken, "");
    // The pinned clock gives both the same creation instant, so order is
    // the id tie-break and not asserted here.
    expect(names(all).toSorted()).toEqual(["Mine", "Theirs"]);
    const mineItem = all.artifacts.find((item) => item.artifact.name === "Mine");
    expect(mineItem).toMatchObject({
      currentVersionNumber: 2,
      owner: {displayName: owner.displayName, principalId: owner.id},
      updatedAt: second.body.version.createdAt,
      versionCount: 2,
      views: {last30Days: 2, total: 2},
    });
    expect(all.artifacts.find((item) => item.artifact.name === "Theirs"))
      .toMatchObject({currentVersionNumber: 1, views: {last30Days: 0, total: 0}});

    // `me` and `others` split the same project by creator, from each side.
    expect(names(await list(running, installation.apiToken, "&owner=me")))
      .toEqual(["Mine"]);
    expect(names(await list(running, installation.apiToken, "&owner=others")))
      .toEqual(["Theirs"]);
    expect(names(await list(running, releaseBot, "&owner=me")))
      .toEqual(["Theirs"]);
    expect(names(await list(running, releaseBot, "&owner=others")))
      .toEqual(["Mine"]);
  }, 60_000);

  test("FRK-010-F: an unknown owner scope is refused, a version by someone else never moves ownership, and an upgraded database takes owners from first versions", async () => {
    const running = await start();
    const unknown = await fetch(
      `${running.baseUrl}/api/v1/artifacts?owner=everyone`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(unknown.status).toBe(422);

    const releaseBot = await serviceKey(running, installation, "Release bot");
    const bot = await readPrincipal(running, releaseBot);
    const botArtifact = await publishNew(running, asPrincipal(installation, releaseBot), {
      accessSetting: "account_required",
      content: "<!doctype html><title>Bot first</title>",
      idempotencyKey: "frk-010-owner-bot-first",
      name: "Bot first",
    });
    const owner = await readPrincipal(running, installation.apiToken);
    await publishVersion(running, installation, {
      artifactId: botArtifact.body.artifact.id,
      content: "<!doctype html><title>Owner second</title>",
      expectedCurrentVersionId: botArtifact.body.version.id,
      idempotencyKey: requestFrk010OwnerOwnerSecond,
    });
    // The administrator published version 2 but created nothing, so it owns
    // nothing.
    expect(names(await list(running, installation.apiToken, "&owner=me")))
      .toEqual([]);
    await running.stop();
    server = null;

    // Rewind to schema 14: no owner columns and no publisher names.
    const databasePath = path.join(installation.dataDirectory, "artifact-server.db");
    const previous = new DatabaseSync(databasePath);
    try {
      previous.exec(`
        DROP INDEX artifacts_owner_created;
        ALTER TABLE artifacts DROP COLUMN owner_principal_id;
        ALTER TABLE artifacts DROP COLUMN owner_display_name;
        ALTER TABLE versions DROP COLUMN publisher_display_name;
        PRAGMA user_version = 14;
      `);
    } finally {
      previous.close();
    }

    const upgraded = await start();
    const details = await getJson(
      upgraded,
      installation.apiToken,
      `/api/v1/artifacts/${botArtifact.body.artifact.id}`,
      detailSchema,
    );
    // The owner is the first version's publisher; nobody recorded the name
    // that publisher had, so it stays null rather than being guessed.
    expect(details.artifact.owner).toEqual({displayName: null, principalId: bot.id});
    expect(details.current.version).toEqual({
      publisherDisplayName: null,
      publisherPrincipalId: owner.id,
    });
    expect(names(await list(upgraded, releaseBot, "&owner=me")))
      .toEqual(["Bot first"]);
  }, 60_000);
});

async function serviceKey(
  running: RunningTestServer,
  installation: TestInstallation,
  name: string,
): Promise<string> {
  const cookies = await signInAdministrator(running, installation);
  return issueApiKey(
    running,
    cookies,
    ["artifact:create", "artifact:read", "artifact:publish:any"],
    name,
  );
}

function asPrincipal(
  installation: TestInstallation,
  token: string,
): TestInstallation {
  return {...installation, apiToken: token};
}

async function readPrincipal(running: RunningTestServer, token: string) {
  return (await getJson(running, token, "/api/v1/session", sessionSchema))
    .principal;
}

async function list(
  running: RunningTestServer,
  token: string,
  query: string,
): Promise<z.infer<typeof listSchema>> {
  return getJson(
    running,
    token,
    `/api/v1/artifacts?limit=50${query}`,
    listSchema,
  );
}

function names(page: z.infer<typeof listSchema>): readonly string[] {
  return page.artifacts.map((item) => item.artifact.name);
}

async function getJson<Body>(
  running: RunningTestServer,
  token: string,
  pathname: string,
  schema: z.ZodType<Body>,
): Promise<Body> {
  const response = await fetch(`${running.baseUrl}${pathname}`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}
