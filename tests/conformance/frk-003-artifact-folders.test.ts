import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {localOwnerBrowserAccess} from "../../src/core/browser-access.js";
import {parseArtifactFolder} from "../../src/http/same-host-content.js";
import {createLocalRuntime} from "../../src/local/create-local-runtime.js";
import {publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  indexHtml,
  nestedHtml,
  publishSite,
  stylesheet,
} from "../support/same-host-site.js";

const errorBodySchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

function manual(url: string): Promise<Response> {
  return fetch(url, {redirect: "manual"});
}

describe("artifact folders in path mode", () => {
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

  test("FRK-003-B: a public artifact is served at its readable folder, and a new version is served at the same folder", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Báo cáo Q3",
    });
    const uuid = site.artifact.id.slice("art_".length);
    const folderUrl = `${server.baseUrl}/bao-cao-q3-${uuid}/`;
    expect(site.links.artifact).toBe(folderUrl);

    const entry = await fetch(folderUrl);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(indexHtml);
    const css = await fetch(`${folderUrl}assets/a.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(stylesheet);
    const nested = await fetch(`${folderUrl}docs/nested/page.html`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe(nestedHtml);

    const stableLink = await manual(
      `${server.baseUrl}/artifacts/${site.artifact.id}`,
    );
    expect(stableLink.status).toBe(302);
    expect(stableLink.headers.get("location")).toBe(folderUrl);

    const secondVersionHtml = "<!doctype html><title>Folder version two</title>";
    const second = await publishVersion(server, installation, {
      artifactId: site.artifact.id,
      content: secondVersionHtml,
      expectedCurrentVersionId: site.artifact.currentVersionId,
      idempotencyKey: "frk-003-second-version",
    });
    expect(second.body.version.number).toBe(2);
    expect(second.body.links.artifact).toBe(folderUrl);

    const reloaded = await fetch(folderUrl);
    expect(reloaded.status).toBe(200);
    expect(await reloaded.text()).toBe(secondVersionHtml);
    const droppedFile = await fetch(`${folderUrl}assets/a.css`);
    expect(droppedFile.status).toBe(404);
    await droppedFile.arrayBuffer();
  });

  test("FRK-003-F: private folders are refused, wrong names and missing slashes redirect, and no application route can match a content path", async () => {
    const pub = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Báo cáo Q3",
    });
    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Private folder",
    });
    const uuid = pub.artifact.id.slice("art_".length);
    const folder = `bao-cao-q3-${uuid}`;

    const refused = await fetch(priv.links.artifact);
    expect(refused.status).toBe(401);
    expect(errorBodySchema.parse(await refused.json()).error.code)
      .toBe("CONTENT_NOT_PUBLIC");

    const redirects = await Promise.all([
      `/wrong-name-${uuid}/assets/a.css?x=1`,
      `/${uuid}/`,
      `/${folder}?tab=1`,
      `/${folder}`,
    ].map(async (requested) => {
      const response = await manual(`${server.baseUrl}${requested}`);
      await response.arrayBuffer();
      return {
        location: response.headers.get("location"),
        requested,
        status: response.status,
      };
    }));
    expect(redirects).toEqual([
      {
        location: `/${folder}/assets/a.css?x=1`,
        requested: `/wrong-name-${uuid}/assets/a.css?x=1`,
        status: 308,
      },
      {location: `/${folder}/`, requested: `/${uuid}/`, status: 308},
      {
        location: `/${folder}/?tab=1`,
        requested: `/${folder}?tab=1`,
        status: 308,
      },
      {location: `/${folder}/`, requested: `/${folder}`, status: 308},
    ]);

    const unknown = await fetch(
      `${server.baseUrl}/folder-3fa85f64-5717-4562-b3fc-2c963f66afa6/`,
    );
    expect(unknown.status).toBe(404);
    expect(errorBodySchema.parse(await unknown.json()).error.code)
      .toBe("ARTIFACT_NOT_FOUND");

    const lookalike = await fetch(`${server.baseUrl}/${folder}-x/`);
    expect(lookalike.status).toBe(404);
    expect(errorBodySchema.parse(await lookalike.json()).error.code)
      .toBe("NOT_FOUND");

    const routeInstallation = await createTestInstallation();
    const runtime = await createLocalRuntime({
      apiToken: routeInstallation.apiToken,
      browserAccess: localOwnerBrowserAccess,
      contentDomain: null,
      dataDirectory: routeInstallation.dataDirectory,
    });
    try {
      const firstSegments = new Set(
        runtime.app.routes.map((route) => route.path.split("/")[1] ?? ""),
      );
      const reaching = [...firstSegments].filter((segment) =>
        segment === "v" ||
        segment.startsWith(":") ||
        parseArtifactFolder(segment) !== null
      );
      expect(reaching).toEqual([]);
      expect(firstSegments).toContain("api");
    } finally {
      await runtime.close();
      await removeTestInstallation(routeInstallation);
    }
  });
});
