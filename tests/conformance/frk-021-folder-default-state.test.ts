import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";

const protocolVersion = "2026-07-28";
const treeSchema = z.object({
  artifacts: z.array(z.object({name: z.string()})),
  collapsedFolders: z.array(z.string()),
});
const folderDefaultSchema = z.object({
  defaultState: z.enum(["collapsed", "expanded"]),
  path: z.string(),
}).strict();
const errorSchema = z.object({error: z.object({code: z.string()})});
const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});

describe("folder default state", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {contentDomain: null});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function readTree(): Promise<z.infer<typeof treeSchema>> {
    const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
    expect(response.status).toBe(200);
    return treeSchema.parse(await response.json());
  }

  function setFolder(
    body: Readonly<Record<string, string>>,
    token: string | null = installation.apiToken,
  ): Promise<Response> {
    const headers = new Headers({"Content-Type": "application/json"});
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${server.baseUrl}/api/v1/folder-defaults`, {
      body: JSON.stringify(body),
      headers,
      method: "PUT",
    });
  }

  async function publishPublic(name: string, path: string): Promise<void> {
    await publishSite(server, installation, {accessSetting: "public_link", name, path});
  }

  test("FRK-021-B: a folder set collapsed over REST is named by the anonymous tree, and MCP sets it back to expanded", async () => {
    await publishPublic("Old report", "team/archive/old-report");
    await publishPublic("Q1 notes", "team/archive/2025/q1-notes");
    await publishPublic("Agent console", "2026/10/agent-console");
    expect((await readTree()).collapsedFolders).toEqual([]);

    // Leading and trailing slashes normalize the same way a publish path does.
    const collapsed = await setFolder({defaultState: "collapsed", path: "/team/archive/"});
    expect(collapsed.status).toBe(200);
    expect(folderDefaultSchema.parse(await collapsed.json()))
      .toEqual({defaultState: "collapsed", path: "team/archive"});
    // A repeated set is the same state, not a second row.
    expect((await setFolder({defaultState: "collapsed", path: "team/archive"})).status)
      .toBe(200);
    expect((await setFolder({defaultState: "collapsed", path: "team/archive/2025"})).status)
      .toBe(200);

    const tree = await readTree();
    expect(tree.collapsedFolders).toEqual(["team/archive", "team/archive/2025"]);
    // Collapsing changes how the folder starts, never what the tree lists.
    expect(tree.artifacts.map((artifact) => artifact.name).toSorted())
      .toEqual(["Agent console", "Old report", "Q1 notes"]);

    const expanded = await callTool("folder_set_default", {
      defaultState: "expanded",
      path: "team/archive",
    });
    expect(expanded.isError).not.toBe(true);
    expect(folderDefaultSchema.parse(expanded.structuredContent))
      .toEqual({defaultState: "expanded", path: "team/archive"});
    expect((await readTree()).collapsedFolders).toEqual(["team/archive/2025"]);
  });

  test("FRK-021-F: anonymous and member-scoped callers cannot set a folder, a malformed path is refused, and the tree names no folder it does not list", async () => {
    await publishPublic("Old report", "team/archive/old-report");

    expect((await setFolder({defaultState: "collapsed", path: "team/archive"}, null)).status)
      .toBe(401);

    // A member key creates and reads its own work but does not manage
    // artifact settings, so it cannot change how a shared folder starts.
    const cookies = await signInAdministrator(server, installation);
    const member = await issueApiKey(
      server,
      cookies,
      ["artifact:create", "artifact:read"],
      "Member",
    );
    const refused = await setFolder({defaultState: "collapsed", path: "team/archive"}, member);
    expect(refused.status).toBe(403);
    expect(errorSchema.parse(await refused.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    const refusedTool = await callTool(
      "folder_set_default",
      {defaultState: "collapsed", path: "team/archive"},
      member,
    );
    expect(refusedTool.isError).toBe(true);
    expect(errorSchema.parse(refusedTool.structuredContent).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await readTree()).collapsedFolders).toEqual([]);

    for (const body of [
      {defaultState: "collapsed", path: "Team/Archive"},
      {defaultState: "collapsed", path: "api/v1"},
      {defaultState: "collapsed", path: "team//archive"},
      {defaultState: "hidden", path: "team/archive"},
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const invalid = await setFolder(body);
      expect(invalid.status).toBe(422);
    }

    // A folder that holds only a private artifact, and one that holds nothing
    // yet, stay unnamed: the anonymous tree reveals no path it does not list.
    await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Payroll",
      path: "team/private/payroll",
    });
    expect((await setFolder({defaultState: "collapsed", path: "team/private"})).status)
      .toBe(200);
    expect((await setFolder({defaultState: "collapsed", path: "later/batch"})).status)
      .toBe(200);
    expect((await readTree()).collapsedFolders).toEqual([]);

    // The stored setting applies as soon as a public artifact lands there.
    await publishPublic("Batch report", "later/batch/report");
    expect((await readTree()).collapsedFolders).toEqual(["later/batch"]);
  });

  async function callTool(
    name: string,
    toolArguments: Readonly<Record<string, string>>,
    token = installation.apiToken,
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
