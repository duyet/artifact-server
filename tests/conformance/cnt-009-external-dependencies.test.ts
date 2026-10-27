import {readdir, readFile} from "node:fs/promises";
import {createServer, type IncomingHttpHeaders, type Server} from "node:http";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";

const externalMarker = "EXTERNAL-DEPENDENCY-BYTES-5c1e9a";
const html = "text/html; charset=utf-8";
const javascript = "text/javascript; charset=utf-8";

/** Directives that would stop a page from loading another origin's files. */
const fetchDirectives = new Set([
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
]);

const versionManifestSchema = z.object({
  manifest: z.object({entries: z.array(z.object({path: z.string()}).loose())}).loose(),
}).loose();

interface RecordedRequest {
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
}

interface ExternalOrigin {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  stop(): Promise<void>;
}

describe("CNT-009 external dependencies stay external", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let external: ExternalOrigin;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await external.stop();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CNT-009-B: a permitted external dependency loads from its own origin with its URL and bytes unchanged", async () => {
    expect.hasAssertions();
    external = await startExternalOrigin({permitCrossOrigin: true});
    const files = siteReferencing(external.origin);
    const published = await publishSite(files, "cnt-009-permitted-publish");
    expect(external.requests).toEqual([]);

    const page = await fetchVersion(server, published.links.version);
    const pageBytes = new Uint8Array(await page.arrayBuffer());
    expect(page.status).toBe(200);
    expect(pageBytes).toEqual(fileAt(files, "index.html").bytes);
    expectNoFetchRestriction(page.headers.get("content-security-policy"));

    const script = await fetchVersion(
      server,
      new URL("app.js", published.links.version).toString(),
    );
    expect(new Uint8Array(await script.arrayBuffer())).toEqual(fileAt(files, "app.js").bytes);
    expectNoFetchRestriction(script.headers.get("content-security-policy"));
    expect(external.requests).toEqual([]);

    const versionOrigin = new URL(published.links.version).origin;
    const dependencyUrl = `${external.origin}/cdn/library.js`;
    expect(new TextDecoder().decode(pageBytes)).toContain(dependencyUrl);
    const dependency = await fetch(dependencyUrl, {headers: {Origin: versionOrigin}});
    expect(dependency.status).toBe(200);
    expect(dependency.headers.get("access-control-allow-origin")).toBe("*");
    expect(await dependency.text()).toBe(externalBody("/cdn/library.js"));
    expect(external.requests).toEqual([
      {headers: expect.objectContaining({origin: versionOrigin}), url: "/cdn/library.js"},
    ]);
    expect(await dataDirectoryContains(externalMarker)).toBe(false);
  });

  test("CNT-009-F: a blocked external dependency stays blocked and is never proxied or copied", async () => {
    expect.hasAssertions();
    external = await startExternalOrigin({permitCrossOrigin: false});
    const files = siteReferencing(external.origin);
    const published = await publishSite(files, "cnt-009-blocked-publish");
    const externalHost = new URL(external.origin).host;

    const version = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}` +
        `?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(version.status).toBe(200);
    expect(versionManifestSchema.parse(await version.json()).manifest.entries
      .map((entry) => entry.path)).toEqual(files.map((file) => file.path).toSorted());

    for (const file of files) {
      // Requests stay ordered so the recording origin sees any proxy attempt in turn.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchVersion(
        server,
        new URL(file.path, published.links.version).toString(),
      );
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
    }

    for (const proxyPath of [
      "/cdn/library.js",
      `/${external.origin}/cdn/library.js`,
      `/${externalHost}/cdn/library.js`,
      `/${encodeURIComponent(`${external.origin}/cdn/library.js`)}`,
      `/?url=${encodeURIComponent(`${external.origin}/cdn/library.js`)}`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchVersion(
        server,
        new URL(proxyPath, published.links.version).toString(),
      );
      // eslint-disable-next-line no-await-in-loop
      const body = await response.text();
      expect({path: proxyPath, proxied: body.includes(externalMarker)})
        .toEqual({path: proxyPath, proxied: false});
    }
    expect(external.requests).toEqual([]);

    const versionOrigin = new URL(published.links.version).origin;
    const blocked = await fetch(`${external.origin}/cdn/library.js`, {
      headers: {Origin: versionOrigin},
    });
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
    await blocked.arrayBuffer();
    expect(await dataDirectoryContains(externalMarker)).toBe(false);
  });

  async function publishSite(
    files: readonly TestSiteFile[],
    idempotencyKey: string,
  ): Promise<PublishResponse> {
    const upload = await createStagedUpload(server, installation, "index.html", files);
    expect(upload.response.status).toBe(201);
    const uploads = await uploadEveryStagedFile(installation, upload.body, files);
    expect(uploads.map((response) => response.status)).toEqual(uploads.map(() => 200));
    await Promise.all(uploads.map((response) => response.arrayBuffer()));
    const committed = await commitStagedUpload(installation, upload.body, idempotencyKey, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "External dependencies",
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  async function dataDirectoryContains(marker: string): Promise<boolean> {
    const entries = await readdir(installation.dataDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries.filter((entry) => entry.isFile());
    const contents = await Promise.all(files.map((entry) =>
      readFile(path.join(entry.parentPath, entry.name))
    ));
    return contents.some((bytes) => bytes.includes(marker));
  }
});

function siteReferencing(origin: string): readonly TestSiteFile[] {
  return [
    text("index.html", html, [
      "<!doctype html><html><head><title>External</title>",
      `<link rel="stylesheet" href="${origin}/cdn/theme.css">`,
      `<script src="${origin}/cdn/library.js"></script>`,
      "</head><body>",
      `<img src="${origin}/cdn/logo.png" alt="">`,
      "<script type=\"module\" src=\"./app.js\"></script>",
      "</body></html>",
    ].join("")),
    text("app.js", javascript, [
      `const font = new FontFace("Brand", "url(${origin}/cdn/brand.woff2)");`,
      `fetch("${origin}/cdn/data.json").then((response) => response.json());`,
      "export {font};",
    ].join("\n")),
  ];
}

function expectNoFetchRestriction(policy: string | null): void {
  const directives = (policy ?? "")
    .split(/[;,]/u)
    .map((directive) => directive.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name.length > 0);
  expect(directives.filter((name) => fetchDirectives.has(name))).toEqual([]);
}

function externalBody(url: string): string {
  return `/* ${externalMarker} ${url} */`;
}

async function startExternalOrigin(
  options: {readonly permitCrossOrigin: boolean},
): Promise<ExternalOrigin> {
  const requests: RecordedRequest[] = [];
  const origin: Server = createServer((request, response) => {
    const url = request.url ?? "/";
    requests.push({headers: request.headers, url});
    if (options.permitCrossOrigin) response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(externalBody(url));
  });
  await new Promise<void>((resolve) => {
    origin.listen(0, "127.0.0.1", resolve);
  });
  const {port} = z.object({port: z.number()}).parse(origin.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise<void>((resolve, reject) => {
      origin.closeAllConnections();
      origin.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  };
}

function fileAt(files: readonly TestSiteFile[], filePath: string): TestSiteFile {
  const file = files.find((candidate) => candidate.path === filePath);
  if (file === undefined) throw new Error(`The site has no ${filePath}.`);
  return file;
}

function text(filePath: string, mediaType: string, content: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path: filePath};
}
