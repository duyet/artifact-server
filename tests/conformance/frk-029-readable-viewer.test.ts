import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
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
  indexHtml,
  nestedHtml,
  publishSite,
  spaShell,
  stylesheet,
} from "../support/same-host-site.js";

const viewerHtml = "<!doctype html><title>Viewer stub</title>";
const sandboxPolicy =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation";
const shellPolicy =
  "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";
const readableVary = ["sec-fetch-dest", "sec-fetch-mode"];

/** What Chromium sends when a person opens a URL in a tab. */
const tabNavigation = {
  Accept: "text/html,application/xhtml+xml",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
};
/** What Chromium sends when the viewer's frame loads or follows a link. */
const frameNavigation = {
  Accept: "text/html,application/xhtml+xml",
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
};
/** An agent, an MCP fetch, or a link preview: no Fetch Metadata at all. */
const nonBrowser = {Accept: "*/*"};

const treeSchema = z.object({
  artifacts: z.array(z.object({
    name: z.string(),
    views: z.object({total: z.number().int().nonnegative()}).loose(),
  }).loose()),
}).loose();

/** The parts of a response this requirement promises. */
async function observe(response: Response) {
  return {
    allowOrigin: response.headers.get("access-control-allow-origin"),
    body: await response.text(),
    policy: response.headers.get("content-security-policy"),
    status: response.status,
    // Compression adds its own Accept-Encoding; this requirement owns the rest.
    vary: (response.headers.get("vary") ?? "").split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.startsWith("sec-fetch-")),
  };
}

const viewer = {
  allowOrigin: null,
  body: viewerHtml,
  policy: shellPolicy,
  status: 200,
  vary: readableVary,
};

function page(body: string, vary: readonly string[] = readableVary) {
  return {allowOrigin: "*", body, policy: sandboxPolicy, status: 200, vary};
}

async function totalViews(server: RunningTestServer, name: string): Promise<number> {
  await server.flushArtifactViews();
  const response = await fetch(`${server.baseUrl}/api/v1/public/tree`);
  const entry = treeSchema.parse(await response.json()).artifacts
    .find((artifact) => artifact.name === name);
  if (entry === undefined) throw new Error(`The public tree holds no artifact named ${name}.`);
  return entry.views.total;
}

describe("the viewer at readable artifact URLs", () => {
  let installation: TestInstallation;
  let webAssetsRoot: string;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "frk-029-web-assets-"));
    await writeFile(path.join(webAssetsRoot, "viewer.html"), viewerHtml);
    server = await startTestServer(installation, {contentDomain: null, webAssetsRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  async function get(url: string, headers: Record<string, string>, method = "GET") {
    return observe(await fetchVersion(server, url, method, headers));
  }

  test("FRK-029-B: a tab's navigation to an HTML page at a readable URL gets the viewer under the application policy, while frames, raw=1, and clients without Fetch Metadata get the sandboxed page, and one framed view counts once", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const spa = await publishSite(server, installation, {
      accessSetting: "public_link",
      entry: spaShell,
      name: "Agent console SPA",
      path: "2026/10/agent-console-spa",
      routingMode: "spa",
    });
    const pathUrl = `${server.baseUrl}/2026/10/agent-console/`;
    const folderUrl = `${server.baseUrl}/agent-console-${site.artifact.id.slice("art_".length)}/`;

    expect(await get(pathUrl, tabNavigation)).toEqual(viewer);
    expect(await get(folderUrl, tabNavigation)).toEqual(viewer);
    expect(await get(`${pathUrl}docs/nested/page.html`, tabNavigation)).toEqual(viewer);
    expect(await get(`${spa.links.artifact}settings/profile`, tabNavigation)).toEqual(viewer);
    const shell = await fetchVersion(server, pathUrl, "GET", tabNavigation);
    expect(shell.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(shell.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    // A tab that revalidates the page it cached before the viewer existed, and
    // a frame that sends the viewer's validator, each get their own body.
    const viewerEtag = shell.headers.get("etag");
    const pageEtag = (await fetchVersion(server, pathUrl, "GET", nonBrowser)).headers.get("etag");
    if (viewerEtag === null || pageEtag === null) throw new Error("A body carries no ETag.");
    expect(viewerEtag).not.toBe(pageEtag);
    expect(await get(pathUrl, {...tabNavigation, "If-None-Match": pageEtag})).toEqual(viewer);
    expect(await get(`${pathUrl}?raw=1`, {...frameNavigation, "If-None-Match": viewerEtag}))
      .toEqual(page(indexHtml));

    expect(await get(`${pathUrl}?raw=1`, frameNavigation)).toEqual(page(indexHtml));
    expect(await get(`${pathUrl}docs/nested/page.html`, frameNavigation))
      .toEqual(page(nestedHtml));
    expect(await get(`${spa.links.artifact}settings/profile?raw=1`, frameNavigation))
      .toEqual(page(spaShell));
    expect(await get(`${pathUrl}?raw=1`, tabNavigation)).toEqual(page(indexHtml));
    expect(await get(pathUrl, nonBrowser)).toEqual(page(indexHtml));
    expect(await get(folderUrl, nonBrowser)).toEqual(page(indexHtml));
    // A stylesheet opened in a tab is not a page, so it never gets the viewer
    // and its answer does not depend on the request's Fetch Metadata.
    expect(await get(`${pathUrl}assets/a.css`, tabNavigation)).toEqual(page(stylesheet, []));
    const probe = await fetchVersion(server, pathUrl, "HEAD", tabNavigation);
    expect(probe.status).toBe(200);
    expect(probe.headers.get("content-security-policy")).toBe(sandboxPolicy);
    // The exact version URL is raw immutable content, never a viewer.
    expect(await get(site.links.version, tabNavigation)).toEqual(page(indexHtml, []));

    // The viewer's own answer counted nothing above; each page answer did.
    // Reset the baseline, then load the page once the way a person does.
    const before = await totalViews(server, "Agent console");
    expect((await get(pathUrl, tabNavigation)).body).toBe(viewerHtml);
    expect((await get(`${pathUrl}?raw=1`, frameNavigation)).body).toBe(indexHtml);
    expect(await totalViews(server, "Agent console")).toBe(before + 1);
    expect((await get(pathUrl, nonBrowser)).body).toBe(indexHtml);
    expect(await totalViews(server, "Agent console")).toBe(before + 2);
  });

  test("FRK-029-F: private, missing, and unknown readable URLs answer a tab exactly as before with no viewer, the viewer never counts a view, and a server without the viewer page serves the page itself", async () => {
    await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Internal ledger",
      path: "2026/10/internal-ledger",
    });
    await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const pathUrl = `${server.baseUrl}/2026/10/agent-console/`;

    const priv = await get(`${server.baseUrl}/2026/10/internal-ledger/`, tabNavigation);
    expect(priv).toMatchObject({allowOrigin: "*", policy: sandboxPolicy, status: 401, vary: []});
    expect(priv.body).toContain("CONTENT_NOT_PUBLIC");
    expect(await get(`${pathUrl}missing.html`, tabNavigation))
      .toMatchObject({policy: sandboxPolicy, status: 404});
    expect(await get(`${server.baseUrl}/2026/10/absent/`, tabNavigation))
      .toMatchObject({policy: sandboxPolicy, status: 404});
    const post = await fetchVersion(server, pathUrl, "POST", tabNavigation);
    expect(post.status).toBe(405);
    expect(post.headers.get("content-security-policy")).toBe(sandboxPolicy);

    const tabs = await Promise.all([1, 2, 3].map(() => get(pathUrl, tabNavigation)));
    expect(tabs.map((tab) => tab.body)).toEqual([viewerHtml, viewerHtml, viewerHtml]);
    expect(await totalViews(server, "Agent console")).toBe(0);

    await rm(path.join(webAssetsRoot, "viewer.html"));
    await server.stop();
    server = await startTestServer(installation, {contentDomain: null, webAssetsRoot});
    expect(await get(pathUrl, tabNavigation)).toEqual(page(indexHtml));
    expect(await totalViews(server, "Agent console")).toBe(1);
  });
});
