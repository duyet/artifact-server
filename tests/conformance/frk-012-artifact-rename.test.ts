import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
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
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const stateSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}),
  replayed: z.boolean(),
  version: z.object({id: z.string()}),
});
const errorSchema = z.object({error: z.object({code: z.string()})});
const listSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({name: z.string()})})),
});
const actionsSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    idempotencyKey: z.string(),
    versionId: z.string(),
  })),
});
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
});

describe("artifact rename", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publish(name: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `frk-012-publish-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
    })).body;
  }

  function rename(
    published: PublishResponse,
    body: {readonly expectedCurrentVersionId: string; readonly name: string},
    idempotencyKey: string | null,
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${installation.apiToken}`,
      "Content-Type": "application/json",
    });
    if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/name`,
      {body: JSON.stringify(body), headers, method: "PATCH"},
    );
  }

  test("FRK-012-B: a rename changes only the name, is searchable, recorded as renamed, replays what it set, and MCP renames the same way", async () => {
    const published = await publish("Quarterly draft");

    const renamed = await rename(published, {
      expectedCurrentVersionId: published.version.id,
      name: "  Quarterly report  ",
    }, "frk-012-rename-first");
    expect(renamed.status).toBe(200);
    const state = stateSchema.parse(await renamed.json());
    expect(state).toMatchObject({
      artifact: {id: published.artifact.id, name: "Quarterly report"},
      replayed: false,
      // A rename saves no version.
      version: {id: published.version.id},
    });

    expect(await searchNames("quarterly report")).toEqual(["Quarterly report"]);
    expect(await searchNames("draft")).toEqual([]);

    // MCP renames through the same service and records the same action.
    const viaMcp = await callTool("artifact_rename", {
      artifactId: published.artifact.id,
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: "frk-012-rename-mcp",
      name: "Quarterly report (final)",
    });
    expect(viaMcp.isError).not.toBe(true);
    expect(stateSchema.parse(viaMcp.structuredContent).artifact.name)
      .toBe("Quarterly report (final)");

    // The first key replays the name it set, not the name the artifact has now.
    const replayed = await rename(published, {
      expectedCurrentVersionId: published.version.id,
      name: "  Quarterly report  ",
    }, "frk-012-rename-first");
    expect(replayed.status).toBe(200);
    expect(stateSchema.parse(await replayed.json())).toMatchObject({
      artifact: {name: "Quarterly report"},
      replayed: true,
    });

    const actions = await readActions(published);
    expect(actions.filter((action) => action.action === "renamed")).toEqual([
      {
        action: "renamed",
        idempotencyKey: "frk-012-rename-mcp",
        versionId: published.version.id,
      },
      {
        action: "renamed",
        idempotencyKey: "frk-012-rename-first",
        versionId: published.version.id,
      },
    ]);
  }, 60_000);

  test("FRK-012-F: a stale version, a reused key, a blank name, a missing key, and a deleted artifact change nothing", async () => {
    const published = await publish("Roadmap");
    const second = await publishVersion(server, installation, {
      artifactId: published.artifact.id,
      content: "<!doctype html><title>Roadmap two</title>",
      expectedCurrentVersionId: published.version.id,
      idempotencyKey: "frk-012-roadmap-second",
    });

    const stale = await rename(published, {
      expectedCurrentVersionId: published.version.id,
      name: "Stale roadmap",
    }, "frk-012-rename-stale");
    expect(stale.status).toBe(409);
    expect(errorSchema.parse(await stale.json()).error.code)
      .toBe("ARTIFACT_MUTATION_CONFLICT");

    const accepted = await rename(published, {
      expectedCurrentVersionId: second.body.version.id,
      name: "Roadmap 2027",
    }, "frk-012-rename-accepted");
    expect(accepted.status).toBe(200);
    const reused = await rename(published, {
      expectedCurrentVersionId: second.body.version.id,
      name: "Roadmap 2028",
    }, "frk-012-rename-accepted");
    expect(reused.status).toBe(409);
    expect(errorSchema.parse(await reused.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const blank = await rename(published, {
      expectedCurrentVersionId: second.body.version.id,
      name: "   ",
    }, "frk-012-rename-blank");
    expect(blank.status).toBe(422);
    const unkeyed = await rename(published, {
      expectedCurrentVersionId: second.body.version.id,
      name: "Unkeyed roadmap",
    }, null);
    expect(unkeyed.status).toBe(422);
    expect(await searchNames("roadmap")).toEqual(["Roadmap 2027"]);

    const deletion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: second.body.version.id}),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "frk-012-roadmap-delete",
        },
        method: "DELETE",
      },
    );
    expect(deletion.status).toBe(200);
    const afterDelete = await rename(published, {
      expectedCurrentVersionId: second.body.version.id,
      name: "Ghost roadmap",
    }, "frk-012-rename-ghost");
    expect(afterDelete.status).toBe(404);

    const renamedActions = (await readActions(published))
      .filter((action) => action.action === "renamed");
    expect(renamedActions.map((action) => action.idempotencyKey))
      .toEqual(["frk-012-rename-accepted"]);
  }, 60_000);

  test("foundation: an idempotency table from before renames is rebuilt with its records and triggers", async () => {
    const published = await publish("Before renames");
    const tagged = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.version.id,
          tags: ["kept"],
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "frk-012-tags-before",
        },
        method: "PATCH",
      },
    );
    expect(tagged.status).toBe(200);
    await server.stop();

    const databasePath = path.join(installation.dataDirectory, "artifact-server.db");
    const previous = new DatabaseSync(databasePath);
    try {
      previous.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE idempotency_records_old (
          project_id TEXT NOT NULL REFERENCES projects(id),
          idempotency_key TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, idempotency_key)
        ) STRICT;
        INSERT INTO idempotency_records_old SELECT
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        FROM idempotency_records;
        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_old RENAME TO idempotency_records;
        PRAGMA user_version = 14;
      `);
    } finally {
      previous.close();
    }

    server = await startTestServer(installation);
    const replayedTags = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.version.id,
          tags: ["kept"],
        }),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "frk-012-tags-before",
        },
        method: "PATCH",
      },
    );
    expect(replayedTags.status).toBe(200);
    expect(stateSchema.parse(await replayedTags.json()).replayed).toBe(true);
    const renamed = await rename(published, {
      expectedCurrentVersionId: published.version.id,
      name: "After renames",
    }, "frk-012-rename-after-upgrade");
    expect(renamed.status).toBe(200);

    const upgraded = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(upgraded.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'trigger' AND tbl_name = 'idempotency_records'
         ORDER BY name`,
      ).all()).toEqual([
        {name: "idempotency_project_insert"},
        {name: "idempotency_project_update"},
      ]);
    } finally {
      upgraded.close();
    }
  }, 60_000);

  async function searchNames(search: string): Promise<readonly string[]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts?search=${encodeURIComponent(search)}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).artifacts
      .map((item) => item.artifact.name);
  }

  async function readActions(published: PublishResponse) {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/actions?limit=100`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return actionsSchema.parse(await response.json()).actions;
  }

  async function callTool(
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
        Authorization: `Bearer ${installation.apiToken}`,
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
