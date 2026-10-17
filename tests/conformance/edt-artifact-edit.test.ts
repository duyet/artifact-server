import {createHash} from "node:crypto";

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
import {
  commitStagedUpload,
  createStagedUpload,
  type PublishResponse,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const maximumEditableTextBytes = 1_048_576;
const encoder = new TextEncoder();

const manifestEntrySchema = z.object({
  disposition: z.string(),
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});
const versionSchema = z.object({
  manifest: z.object({
    entries: z.array(manifestEntrySchema),
    entryPath: z.string(),
    routingMode: z.string(),
  }),
  version: z.object({id: z.string(), number: z.number()}),
});
const committedSchema = z.object({
  replayed: z.boolean(),
  version: z.object({
    id: z.string(),
    number: z.number(),
    publisherPrincipalId: z.string(),
  }),
});
const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const versionListSchema = z.object({
  versions: z.array(z.object({version: z.object({id: z.string()})})),
});
const actionsSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    idempotencyKey: z.string(),
    versionId: z.string(),
  })),
});
const toolResultSchema = z.object({
  error: z.unknown().optional(),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose().optional(),
});

function textFile(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: encoder.encode(content), mediaType, path};
}

function untouched(
  entries: z.infer<typeof versionSchema>["manifest"]["entries"],
): z.infer<typeof versionSchema>["manifest"]["entries"] {
  return entries.filter((entry) => entry.path !== "notes.md");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const baseFiles: readonly TestSiteFile[] = [
  textFile("index.html", "<!doctype html><title>Handbook</title>", "text/html; charset=utf-8"),
  textFile("notes.md", "# Notes\n\nFirst draft.\n", "text/markdown; charset=utf-8"),
  textFile("readme.txt", "Plain text.\n", "text/plain; charset=utf-8"),
  textFile("data.json", "{\"version\":1}\n", "application/json"),
  {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mediaType: "image/png",
    path: "logo.png",
  },
];

describe("editing one text file", () => {
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

  async function publishHandbook(): Promise<PublishResponse> {
    const upload = await createStagedUpload(
      server,
      installation,
      "index.html",
      baseFiles,
    );
    await uploadEveryStagedFile(installation, upload.body, baseFiles);
    const committed = await commitStagedUpload(
      installation,
      upload.body,
      "edt-handbook-publish",
      {accessSetting: "account_required", kind: "new_artifact", name: "Handbook"},
    );
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  /** Stage the given files and commit them as an edit; nothing is skipped. */
  async function commitEdit(
    published: PublishResponse,
    input: {
      readonly baseVersionId?: string;
      readonly expectedCurrentVersionId?: string;
      readonly files: readonly TestSiteFile[];
      readonly idempotencyKey: string;
      readonly path: string;
      readonly upload?: boolean;
    },
  ): Promise<Response> {
    const entryPath = input.files[0]?.path ?? input.path;
    const upload = await createStagedUpload(server, installation, entryPath, input.files);
    expect(upload.response.status).toBe(201);
    const uploaded = input.upload === false
      ? []
      : await uploadEveryStagedFile(installation, upload.body, input.files);
    expect(uploaded.map((response) => response.status))
      .toEqual(uploaded.map(() => 200));
    return fetch(upload.body.commitUrl, {
      body: JSON.stringify({
        target: {
          artifactId: published.artifact.id,
          baseVersionId: input.baseVersionId ?? published.version.id,
          expectedCurrentVersionId:
            input.expectedCurrentVersionId ?? published.version.id,
          kind: "edit",
          path: input.path,
        },
      }),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      method: "POST",
    });
  }

  async function readVersion(published: PublishResponse, versionId: string) {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${versionId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return versionSchema.parse(await response.json());
  }

  async function readFile(
    published: PublishResponse,
    versionId: string,
    path: string,
  ): Promise<Uint8Array> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${versionId}/file?path=${encodeURIComponent(path)}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function versionIds(published: PublishResponse): Promise<readonly string[]> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return versionListSchema.parse(await response.json()).versions
      .map((item) => item.version.id);
  }

  async function expectRefused(
    response: Response,
    status: number,
    code: string,
  ): Promise<string> {
    expect(response.status).toBe(status);
    const body = errorSchema.parse(await response.json());
    expect(body.error.code).toBe(code);
    return body.error.message;
  }

  test("EDT-001-B: an edit saves a version equal to its base except the one edited entry, records it as edited, and replays", async () => {
    const published = await publishHandbook();
    const edited = textFile(
      "notes.md",
      "# Notes\n\nSecond draft.\n",
      "text/markdown; charset=utf-8",
    );
    const response = await commitEdit(published, {
      files: [edited],
      idempotencyKey: "edt-001-notes-edit",
      path: "notes.md",
    });
    expect(response.status).toBe(201);
    const committed = committedSchema.parse(await response.json());
    expect(committed).toMatchObject({replayed: false, version: {number: 2}});

    const base = await readVersion(published, published.version.id);
    const next = await readVersion(published, committed.version.id);
    expect(next.manifest.entryPath).toBe(base.manifest.entryPath);
    expect(next.manifest.routingMode).toBe(base.manifest.routingMode);
    expect(untouched(next.manifest.entries)).toEqual(untouched(base.manifest.entries));
    expect(untouched(next.manifest.entries)).toHaveLength(baseFiles.length - 1);
    expect(next.manifest.entries.find((entry) => entry.path === "notes.md"))
      .toEqual({
        disposition: "inline",
        mediaType: "text/markdown; charset=utf-8",
        path: "notes.md",
        sha256: sha256(edited.bytes),
        size: edited.bytes.byteLength,
      });
    expect(await readFile(published, committed.version.id, "notes.md"))
      .toEqual(edited.bytes);
    // The base version still serves the bytes it was saved with.
    expect(await readFile(published, published.version.id, "notes.md"))
      .toEqual(baseFiles[1]?.bytes);

    const replay = await commitEdit(published, {
      files: [edited],
      idempotencyKey: "edt-001-notes-edit",
      path: "notes.md",
    });
    expect(replay.status).toBe(200);
    expect(committedSchema.parse(await replay.json())).toMatchObject({
      replayed: true,
      version: {id: committed.version.id},
    });

    const actionsResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/actions?limit=100`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    const actions = actionsSchema.parse(await actionsResponse.json()).actions;
    expect(actions.filter((action) => action.action === "edited")).toEqual([{
      action: "edited",
      idempotencyKey: "edt-001-notes-edit",
      versionId: committed.version.id,
    }]);
  }, 60_000);

  test("EDT-001-F: an absent path, a mismatched or extra upload, an unknown base, and an unverified upload save nothing", async () => {
    const published = await publishHandbook();
    const absent = await commitEdit(published, {
      files: [textFile("missing.md", "# Missing\n", "text/markdown")],
      idempotencyKey: "edt-001-absent-path",
      path: "missing.md",
    });
    await expectRefused(absent, 422, "INVALID_INPUT");

    const mismatched = await commitEdit(published, {
      files: [textFile("readme.txt", "Other file.\n", "text/plain")],
      idempotencyKey: "edt-001-mismatched-path",
      path: "notes.md",
    });
    await expectRefused(mismatched, 422, "INVALID_INPUT");

    const extra = await commitEdit(published, {
      files: [
        textFile("notes.md", "# Notes\n", "text/markdown"),
        textFile("readme.txt", "Extra.\n", "text/plain"),
      ],
      idempotencyKey: "edt-001-extra-file",
      path: "notes.md",
    });
    await expectRefused(extra, 422, "INVALID_INPUT");

    const unknownBase = await commitEdit(published, {
      baseVersionId: "ver_00000000-0000-4000-8000-000000000000",
      files: [textFile("notes.md", "# Notes\n", "text/markdown")],
      idempotencyKey: "edt-001-unknown-base",
      path: "notes.md",
    });
    await expectRefused(unknownBase, 404, "VERSION_NOT_FOUND");

    const unverified = await commitEdit(published, {
      files: [textFile("notes.md", "# Never uploaded\n", "text/markdown")],
      idempotencyKey: "edt-001-unverified",
      path: "notes.md",
      upload: false,
    });
    expect(unverified.status).toBe(409);

    expect(await versionIds(published)).toEqual([published.version.id]);
    expect(await readFile(published, published.version.id, "notes.md"))
      .toEqual(baseFiles[1]?.bytes);
  }, 60_000);

  test("the committed file keeps the byte order mark and CRLF line endings it was uploaded with", async () => {
    const published = await publishHandbook();
    const bytes = new Uint8Array([
      0xef, 0xbb, 0xbf,
      ...encoder.encode("Line one\r\nLine two, changed\r\nLine three\r\n"),
    ]);
    const response = await commitEdit(published, {
      files: [{bytes, mediaType: "text/plain; charset=utf-8", path: "readme.txt"}],
      idempotencyKey: "edt-002-bom-crlf",
      path: "readme.txt",
    });
    expect(response.status).toBe(201);
    const committed = committedSchema.parse(await response.json());
    expect(await readFile(published, committed.version.id, "readme.txt"))
      .toEqual(bytes);
    // The untouched files are the same bytes the base version holds.
    expect(await readFile(published, committed.version.id, "notes.md"))
      .toEqual(baseFiles[1]?.bytes);
  }, 60_000);

  test("EDT-002-F: a save against a stale current version is the publish conflict naming the actual current version and saves nothing", async () => {
    const published = await publishHandbook();
    const first = await commitEdit(published, {
      files: [textFile("notes.md", "# Notes\n\nTheirs.\n", "text/markdown")],
      idempotencyKey: "edt-002-first-save",
      path: "notes.md",
    });
    expect(first.status).toBe(201);
    const current = committedSchema.parse(await first.json()).version.id;

    const stale = await commitEdit(published, {
      files: [textFile("notes.md", "# Notes\n\nMine.\n", "text/markdown")],
      idempotencyKey: "edt-002-stale-save",
      path: "notes.md",
    });
    const message = await expectRefused(stale, 409, "PUBLISH_CONFLICT");
    expect(message).toContain(current);
    expect(await versionIds(published)).toEqual([current, published.version.id]);
  }, 60_000);

  test("EDT-003-B: markdown, plain text, and JSON entries up to the size bound commit with bytes that hash-match the upload", async () => {
    const published = await publishHandbook();
    const edits: readonly TestSiteFile[] = [
      textFile("notes.md", "# Notes\n\nEdited markdown.\n", "text/markdown; charset=utf-8"),
      textFile("readme.txt", "x".repeat(maximumEditableTextBytes), "text/plain; charset=utf-8"),
      textFile("data.json", "{\"version\":2}\n", "application/json"),
    ];
    // Each edit builds on the version the previous one saved.
    const editInTurn = async (index: number, baseVersionId: string): Promise<void> => {
      const file = edits[index];
      if (file === undefined) return;
      const response = await commitEdit(published, {
        baseVersionId,
        expectedCurrentVersionId: baseVersionId,
        files: [file],
        idempotencyKey: `edt-003-text-edit-${index}`,
        path: file.path,
      });
      expect(response.status).toBe(201);
      const savedVersionId = committedSchema.parse(await response.json()).version.id;
      const saved = await readVersion(published, savedVersionId);
      expect(saved.manifest.entries.find((entry) => entry.path === file.path))
        .toMatchObject({sha256: sha256(file.bytes), size: file.bytes.byteLength});
      await editInTurn(index + 1, savedVersionId);
    };
    await editInTurn(0, published.version.id);
  }, 60_000);

  test("EDT-003-F: binary and oversize edits are refused, and MCP accepts no edit and says so", async () => {
    const published = await publishHandbook();
    const binary = await commitEdit(published, {
      files: [{bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png", path: "logo.png"}],
      idempotencyKey: "edt-003-binary-edit",
      path: "logo.png",
    });
    await expectRefused(binary, 422, "INVALID_INPUT");

    const textOverBinary = await commitEdit(published, {
      files: [textFile("logo.png", "not an image", "text/plain")],
      idempotencyKey: "edt-003-text-over-binary",
      path: "logo.png",
    });
    await expectRefused(textOverBinary, 422, "INVALID_INPUT");

    const oversize = await commitEdit(published, {
      files: [textFile(
        "readme.txt",
        "x".repeat(maximumEditableTextBytes + 1),
        "text/plain",
      )],
      idempotencyKey: "edt-003-oversize-edit",
      path: "readme.txt",
    });
    await expectRefused(oversize, 422, "INVALID_INPUT");
    expect(await versionIds(published)).toEqual([published.version.id]);

    const capabilities = await callTool("artifact_capabilities", {});
    expect(capabilities.result?.structuredContent).toMatchObject({
      editing: {maximumTextFileBytes: maximumEditableTextBytes, mcpTool: false},
    });
    // A real, fully uploaded staging slot, so only the edit target can be
    // what MCP refuses.
    const staged = [textFile("notes.md", "# Via MCP\n", "text/markdown")];
    const mcpUpload = await createStagedUpload(server, installation, "notes.md", staged);
    await uploadEveryStagedFile(installation, mcpUpload.body, staged);
    const mcpEdit = await callTool("artifact_commit_upload", {
      idempotencyKey: "edt-003-mcp-edit-attempt",
      target: {
        artifactId: published.artifact.id,
        baseVersionId: published.version.id,
        expectedCurrentVersionId: published.version.id,
        kind: "edit",
        path: "notes.md",
      },
      uploadId: mcpUpload.body.uploadId,
    });
    expect(mcpEdit.error !== undefined || mcpEdit.result?.isError === true)
      .toBe(true);
    expect(await versionIds(published)).toEqual([published.version.id]);
  }, 60_000);

  async function callTool(
    name: string,
    toolArguments: Readonly<Record<string, string | Readonly<Record<string, string>>>>,
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
    return toolResultSchema.parse(await response.json());
  }
});
