import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import {execFile} from "node:child_process";
import {writeFile} from "node:fs/promises";
import nodePath from "node:path";
import {promisify} from "node:util";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  createStagedUpload,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const repositoryRoot = nodePath.resolve(import.meta.dirname, "../..");
const runFile = promisify(execFile);

type ToolArguments = Readonly<Record<string, string | Readonly<Record<string, string>>>>;
const encoder = new TextEncoder();

const referenceSchema = z.object({
  confidence: z.enum(["certain", "heuristic"]),
  file: z.string(),
  kind: z.string(),
  line: z.number().nullable(),
  raw: z.string(),
  resolvedPath: z.string(),
}).strict();
const assetCheckSchema = z.object({
  artifactId: z.string(),
  references: z.array(referenceSchema),
  summary: z.object({
    broken: z.number(),
    byKind: z.record(z.string(), z.number()),
    checkedFiles: z.number(),
    heuristic: z.number(),
    truncated: z.boolean(),
  }).strict(),
  version: z.object({id: z.string()}).loose(),
}).strict();
const committedSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  assetCheck: z.object({broken: z.number(), heuristic: z.number()}).strict().nullable(),
  version: z.object({id: z.string()}).loose(),
}).loose();
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string()}).loose()),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});

const reportFolder: readonly TestSiteFile[] = [
  file("index.html", "text/html", [
    "<!doctype html><html><head>",
    "<link rel=\"stylesheet\" href=\"css/site.css\">",
    "</head><body>",
    "<img src=\"shots/a.jpg\" alt=\"correct\">",
    "<img src=\"my-report/shots/a.jpg\" alt=\"repeats its own folder\">",
    "<img srcset=\"shots/a.jpg 1x, shots/a@2x.jpg 2x\" alt=\"one missing candidate\">",
    "<img src=\"https://images.example.com/logo.png\" alt=\"external\">",
    "<template><img src=\"${src}\" alt=\"template\"></template>",
    "<a href=\"pages/about.html\">About</a>",
    "<img src=\"/elsewhere/logo.png\" alt=\"outside the artifact\">",
    "<script>fetch(\"data/ok.json\"); fetch(\"data/missing.json\");</script>",
    "</body></html>",
  ].join("\n")),
  file("css/site.css", "text/css", [
    "@font-face { font-family: Brand; src: url(\"../fonts/brand.woff2\") format(\"woff2\"); }",
    "body { background: url(../shots/a.jpg); }",
  ].join("\n")),
  file("pages/about.html", "text/html",
    "<!doctype html><a href=\"../index.html\">Home</a><img src=\"../shots/a.jpg\" alt=\"up\">"),
  file("pages/based.html", "text/html",
    "<!doctype html><base href=\"../\"><img src=\"shots/a.jpg\" alt=\"via base\"><img src=\"shots/b.jpg\" alt=\"missing via base\">"),
  file("shots/a.jpg", "image/jpeg", "jpeg"),
  file("data/ok.json", "application/json", "{}"),
];

const expectedBroken = [
  {confidence: "certain", file: "css/site.css", kind: "css-url", line: 1, raw: "../fonts/brand.woff2", resolvedPath: "fonts/brand.woff2"},
  {confidence: "heuristic", file: "index.html", kind: "outside", line: 10, raw: "/elsewhere/logo.png", resolvedPath: "/elsewhere/logo.png"},
  {confidence: "heuristic", file: "index.html", kind: "script", line: 11, raw: "data/missing.json", resolvedPath: "data/missing.json"},
  {confidence: "certain", file: "index.html", kind: "html-attr", line: 5, raw: "my-report/shots/a.jpg", resolvedPath: "my-report/shots/a.jpg"},
  {confidence: "certain", file: "index.html", kind: "html-attr", line: 6, raw: "shots/a@2x.jpg", resolvedPath: "shots/a@2x.jpg"},
  {confidence: "certain", file: "pages/based.html", kind: "html-attr", line: 1, raw: "shots/b.jpg", resolvedPath: "shots/b.jpg"},
];

describe("broken asset check", () => {
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

  test("FRK-017-B: REST and MCP list exactly the broken references of a published folder, and both commit results carry their counts", async () => {
    const first = await commitOverHttp(reportFolder, "frk-017-first-version", {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "My report",
      path: "my-report",
    });
    expect(first.assetCheck).toEqual({broken: 4, heuristic: 2});

    const current = await readAssetCheck(first.artifact.id, null);
    expect(sortedReferences(current.references)).toEqual(expectedBroken);
    expect(current.version.id).toBe(first.version.id);
    expect(current.summary).toEqual({
      broken: 4,
      byKind: {
        "css-import": 0,
        "css-url": 1,
        "html-attr": 3,
        "meta-refresh": 0,
        outside: 1,
        script: 1,
      },
      checkedFiles: 4,
      heuristic: 2,
      truncated: false,
    });

    // A second version must not change what the first one reports.
    const upload = await stageUpload([
      file("index.html", "text/html", "<!doctype html><img src=\"shots/a.jpg\" alt=\"kept\"><img src=\"shots/c.jpg\" alt=\"new miss\">"),
      file("shots/a.jpg", "image/jpeg", "jpeg"),
    ]);
    const viaMcp = await callTool("artifact_commit_upload", {
      idempotencyKey: "frk-017-second-version",
      target: {
        artifactId: first.artifact.id,
        expectedCurrentVersionId: first.version.id,
        kind: "new_version",
      },
      uploadId: upload.uploadId,
    });
    expect(viaMcp.isError).not.toBe(true);
    const second = committedSchema.parse(viaMcp.structuredContent);
    expect(second.assetCheck).toEqual({broken: 1, heuristic: 0});
    expect(viaMcp.content[0]?.text).toContain("Asset check: 1 broken and 0 possibly broken references.");

    const exactFirst = await readAssetCheck(first.artifact.id, first.version.id);
    expect(sortedReferences(exactFirst.references)).toEqual(expectedBroken);

    const mcpFirst = await callTool("artifact_check_assets", {
      artifactId: first.artifact.id,
      versionId: first.version.id,
    });
    expect(mcpFirst.isError).not.toBe(true);
    const mcpReport = assetCheckSchema.parse(mcpFirst.structuredContent);
    expect(sortedReferences(mcpReport.references)).toEqual(expectedBroken);
    expect(mcpReport.summary).toEqual(exactFirst.summary);

    const mcpCurrent = assetCheckSchema.parse((await callTool("artifact_check_assets", {
      artifactId: first.artifact.id,
    })).structuredContent);
    expect(mcpCurrent.version.id).toBe(second.version.id);
    expect(mcpCurrent.references.map((reference) => reference.raw)).toEqual(["shots/c.jpg"]);

    const tokenFile = nodePath.join(installation.dataDirectory, "cli-token");
    await writeFile(tokenFile, installation.apiToken);
    const remote = ["--server", server.baseUrl, "--token-file", tokenFile];
    const cliFirst = assetCheckSchema.parse(JSON.parse(
      await runCli(["assets", "check", first.artifact.id, "--version-id", first.version.id, ...remote]),
    ));
    expect(sortedReferences(cliFirst.references)).toEqual(expectedBroken);
    expect((await runCli(["assets", "check", "--all", ...remote])).trim().split("\n")).toEqual([
      expect.stringMatching(/^artifact\s+path\s+broken\s+heuristic$/u),
      expect.stringMatching(new RegExp(`^${first.artifact.id}\\s+my-report\\s+1\\s+0$`, "u")),
    ]);
  }, 60_000);

  test("FRK-017-F: a version without HTML reports zero, limits truncate instead of failing, and unknown or malformed requests are refused", async () => {
    const plain = await commitOverHttp([
      file("notes.txt", "text/plain", "see shots/a.jpg and missing.css"),
      file("shots/a.jpg", "image/jpeg", "jpeg"),
    ], "frk-017-plain-artifact", {accessSetting: "public_link", kind: "new_artifact", name: "Notes"});
    expect(plain.assetCheck).toEqual({broken: 0, heuristic: 0});
    const plainReport = await readAssetCheck(plain.artifact.id, null);
    expect(plainReport.references).toEqual([]);
    expect(plainReport.summary).toMatchObject({
      broken: 0,
      checkedFiles: 0,
      heuristic: 0,
      truncated: false,
    });

    // Unterminated comments, strings, and url() must end the scan, not hang it,
    // and a file over the per-file limit is skipped and reported as truncated.
    const hostile = await commitOverHttp([
      file("index.html", "text/html", "<!doctype html><style>/* never closed url(a.png)"),
      file("broken.css", "text/css", "a { background: url(\"unterminated"),
      file("broken.js", "text/javascript", "const a = 'unterminated.png\n/* never closed"),
      file("huge.html", "text/html", `<img src="missing.png">${" ".repeat(2 * 1_024 * 1_024)}`),
    ], "frk-017-hostile-artifact", {accessSetting: "public_link", kind: "new_artifact", name: "Hostile"});
    const hostileReport = await readAssetCheck(hostile.artifact.id, null);
    expect(hostileReport.summary.truncated).toBe(true);
    expect(hostileReport.summary.checkedFiles).toBe(3);
    expect(hostileReport.references.map((reference) => reference.file)).not.toContain("huge.html");

    const unknownVersion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${plain.artifact.id}/versions/ver_missing/asset-check`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(unknownVersion.status).toBe(404);
    const unauthenticated = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${plain.artifact.id}/asset-check`,
    );
    expect(unauthenticated.status).toBe(401);

    const extraField = await callTool("artifact_check_assets", {
      artifactId: plain.artifact.id,
      path: "notes.txt",
    });
    expect(extraField.isError).toBe(true);
  });

  async function stageUpload(files: readonly TestSiteFile[]) {
    const upload = await createStagedUpload(
      server,
      installation,
      files.some((entry) => entry.path === "index.html") ? "index.html" : (files[0]?.path ?? ""),
      files,
    );
    expect(upload.response.status).toBe(201);
    for (const response of await uploadEveryStagedFile(installation, upload.body, files)) {
      expect(response.ok).toBe(true);
    }
    return upload.body;
  }

  async function commitOverHttp(
    files: readonly TestSiteFile[],
    idempotencyKey: string,
    target: Readonly<Record<string, string>>,
  ) {
    const upload = await stageUpload(files);
    const response = await fetch(upload.commitUrl, {
      body: JSON.stringify({target: {...target, tags: []}}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
    const body: unknown = await response.json();
    expect({body, status: response.status}).toMatchObject({status: 201});
    return committedSchema.parse(body);
  }

  async function readAssetCheck(artifactId: string, versionId: string | null) {
    const route = versionId === null
      ? `/api/v1/artifacts/${artifactId}/asset-check`
      : `/api/v1/artifacts/${artifactId}/versions/${versionId}/asset-check`;
    const response = await fetch(`${server.baseUrl}${route}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(response.status).toBe(200);
    return assetCheckSchema.parse(await response.json());
  }

  async function runCli(argumentsToPass: readonly string[]): Promise<string> {
    const {stdout} = await runFile(
      nodePath.join(repositoryRoot, "node_modules/.bin/tsx"),
      [nodePath.join(repositoryRoot, "src/cli/main.ts"), ...argumentsToPass],
      {cwd: installation.dataDirectory, env: {...process.env, ARTIFACT_SERVER_HOME: installation.dataDirectory}},
    );
    return stdout;
  }

  async function callTool(name: string, toolArguments: ToolArguments) {
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

function file(path: string, mediaType: string, text: string): TestSiteFile {
  return {bytes: encoder.encode(text), mediaType, path};
}

function sortedReferences(references: readonly z.infer<typeof referenceSchema>[]) {
  return references.toSorted((left, right) =>
    referenceKey(left) < referenceKey(right) ? -1 : 1
  );
}

function referenceKey(reference: z.infer<typeof referenceSchema>): string {
  return `${reference.file}\u0000${reference.raw}`;
}
