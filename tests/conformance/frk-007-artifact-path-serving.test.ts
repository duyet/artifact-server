import {randomUUID} from "node:crypto";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishVersion} from "../support/publishing.js";
import {
  apiHeaders,
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

const mcpProtocolVersion = "2026-07-28";
const sandboxPolicy =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation";
/** A navigation of the viewer's frame, the way a browser loads a readable URL's page. */
const frameNavigation = {
  Accept: "text/html",
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
};
const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const artifactDetailsSchema = z.object({
  artifact: z.object({path: z.string().nullable()}).loose(),
  links: z.object({artifact: z.url()}),
});

function isolation(response: Response) {
  return {
    origin: response.headers.get("access-control-allow-origin"),
    policy: response.headers.get("content-security-policy"),
    status: response.status,
  };
}

async function errorCode(response: Response): Promise<string> {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe("artifacts served at their readable paths", () => {
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

  test("FRK-007-B: a public artifact is served at its path, keeps the URL across versions, and every link points there", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Agent console",
      path: "2026/10/agent-console",
    });
    const pathUrl = `${server.baseUrl}/2026/10/agent-console/`;
    expect(site.links.artifact).toBe(pathUrl);

    const entry = await fetch(pathUrl);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(indexHtml);
    const css = await fetch(`${pathUrl}assets/a.css`);
    expect(await css.text()).toBe(stylesheet);
    const nested = await fetch(`${pathUrl}docs/nested/page.html`);
    expect(await nested.text()).toBe(nestedHtml);

    const spa = await publishSite(server, installation, {
      accessSetting: "public_link",
      entry: spaShell,
      name: "Agent console SPA",
      path: "2026/10/agent-console-spa",
      routingMode: "spa",
    });
    const fallback = await fetchVersion(
      server,
      `${spa.links.artifact}settings/profile`,
      "GET",
      frameNavigation,
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(spaShell);

    const stableLink = await fetch(`${server.baseUrl}/artifacts/${site.artifact.id}`, {
      redirect: "manual",
    });
    expect(stableLink.status).toBe(302);
    expect(stableLink.headers.get("location")).toBe(pathUrl);

    const folder = await fetch(
      `${server.baseUrl}/agent-console-${site.artifact.id.slice("art_".length)}/`,
    );
    expect(folder.status).toBe(200);
    expect(await folder.text()).toBe(indexHtml);

    const details = await fetch(`${server.baseUrl}/api/v1/artifacts/${site.artifact.id}`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(z.object({links: z.object({artifact: z.url()})}).parse(await details.json()))
      .toEqual({links: {artifact: pathUrl}});
    const client = new Client(
      {name: "frk-007-artifact-path-client", version: "1"},
      {versionNegotiation: {mode: {pin: mcpProtocolVersion}}},
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
          authProvider: {token: async () => installation.apiToken},
        }),
      );
      const fetched = await client.callTool({
        arguments: {artifactId: site.artifact.id},
        name: "artifact_get",
      });
      expect(fetched.isError).not.toBe(true);
      expect(artifactDetailsSchema.parse(fetched.structuredContent)).toMatchObject({
        artifact: {path: "2026/10/agent-console"},
        links: {artifact: pathUrl},
      });
    } finally {
      await client.close();
    }

    const secondHtml = "<!doctype html><title>Agent console two</title>";
    const second = await publishVersion(server, installation, {
      artifactId: site.artifact.id,
      content: secondHtml,
      expectedCurrentVersionId: site.artifact.currentVersionId,
      idempotencyKey: `frk-007-${randomUUID()}`,
    });
    expect(second.body.links.artifact).toBe(pathUrl);
    const reloaded = await fetch(pathUrl);
    expect(await reloaded.text()).toBe(secondHtml);

    const etag = (await fetch(pathUrl)).headers.get("etag");
    if (etag === null) throw new Error("The entry response has no ETag.");
    const isolated = await Promise.all([
      fetchVersion(server, pathUrl),
      fetchVersion(server, pathUrl, "GET", {Range: "bytes=0-3"}),
      fetchVersion(server, pathUrl, "GET", {"If-None-Match": etag}),
      fetchVersion(server, `${pathUrl}missing.html`),
      fetchVersion(server, pathUrl, "HEAD"),
    ]);
    expect(isolated.map(isolation)).toEqual([200, 206, 304, 404, 200].map((status) => ({
      origin: "*",
      policy: sandboxPolicy,
      status,
    })));
  });

  test("FRK-007-F: private, unknown, deleted, and write requests are refused, a missing slash redirects, and the API stays unsandboxed", async () => {
    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Private console",
      path: "2026/10/private-console",
    });
    const refused = await fetch(priv.links.artifact);
    expect(refused.status).toBe(401);
    expect(await errorCode(refused)).toBe("CONTENT_NOT_PUBLIC");

    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Public console",
      path: "2026/10/public-console",
    });
    const unslashed = await fetch(`${server.baseUrl}/2026/10/public-console?x=1`, {
      redirect: "manual",
    });
    expect(unslashed.status).toBe(308);
    expect(unslashed.headers.get("location")).toBe("/2026/10/public-console/?x=1");
    await unslashed.arrayBuffer();

    const written = await fetch(site.links.artifact, {method: "POST"});
    expect(written.status).toBe(405);
    await written.arrayBuffer();

    const unknown = await fetch(`${server.baseUrl}/2026/09/unknown-report/`);
    expect(isolation(unknown)).toEqual({origin: "*", policy: sandboxPolicy, status: 404});
    expect(await errorCode(unknown)).toBe("NOT_FOUND");

    const session = await fetch(`${server.baseUrl}/api/v1/session`);
    expect(isolation(session)).toEqual({origin: null, policy: null, status: 401});
    await session.arrayBuffer();

    const deleted = await fetch(`${server.baseUrl}/api/v1/artifacts/${site.artifact.id}`, {
      body: JSON.stringify({expectedCurrentVersionId: site.artifact.currentVersionId}),
      headers: apiHeaders(installation, `frk-007-${randomUUID()}`),
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await deleted.arrayBuffer();
    const gone = await fetch(site.links.artifact);
    expect(gone.status).toBe(404);
    expect(await errorCode(gone)).toBe("NOT_FOUND");
  });
});
