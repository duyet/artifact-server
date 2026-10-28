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
import {addAsset, type TestAsset} from "../support/assets.js";
import {publishSite} from "../support/same-host-site.js";
import type {PublishResponse} from "../support/publishing.js";

const recallWarning =
  "New public requests are blocked. Copies already downloaded or cached outside Artifact Server cannot be recalled.";
const accessChangeSchema = z.object({
  artifact: z.object({accessSetting: z.string()}),
  warning: z.string().nullable(),
});
const chart: TestAsset = {
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 7, 0, 0, 7]),
  mediaType: "image/png",
  name: "chart.png",
};

describe("changing public content to account required", () => {
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

  async function changeAccess(
    site: PublishResponse,
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ): Promise<z.infer<typeof accessChangeSchema>> {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${site.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting,
          expectedCurrentVersionId: site.version.id,
        }),
        headers: apiHeaders(installation, idempotencyKey),
        method: "PATCH",
      },
    );
    expect(response.status).toBe(200);
    return accessChangeSchema.parse(await response.json());
  }

  test("AUTH-007-B: the change warns that outside copies cannot be recalled and every public origin URL then refuses anonymous readers", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Launch notes",
      path: "2026/10/launch-notes",
    });
    const publicUrls = [
      site.links.version,
      site.links.artifact,
      new URL("assets/a.css", site.links.version).href,
      new URL("docs/nested/page.html", site.links.artifact).href,
    ];
    const opened = await Promise.all(publicUrls.map(async (url) => ({
      status: (await fetch(url)).status,
      url,
    })));
    expect(opened).toEqual(publicUrls.map((url) => ({status: 200, url})));

    const changed = await changeAccess(site, "account_required", "auth-007-b-private");
    expect(changed.artifact.accessSetting).toBe("account_required");
    // The warning states the limit and never promises recall of outside copies.
    expect(changed.warning).toBe(recallWarning);

    const requests = publicUrls.flatMap((url) =>
      ["GET", "HEAD"].map((method) => ({method, url}))
    );
    const denied = await Promise.all(requests.map(async ({method, url}) => {
      const response = await fetch(url, {method});
      return {
        leaked: (await response.text()).includes("Same-host site"),
        method,
        publiclyCacheable: (response.headers.get("cache-control") ?? "").includes("public"),
        status: response.status,
        url,
      };
    }));
    expect(denied).toEqual(requests.map(({method, url}) => ({
      leaked: false,
      method,
      publiclyCacheable: false,
      status: 401,
      url,
    })));
  });

  test("AUTH-007-F: a stale public cache key, a conditional revalidation, or a range request after the change gets no fresh origin bytes", async () => {
    const site = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Pricing draft",
      path: "2026/10/pricing-draft",
    });
    const asset = await addAsset(
      server,
      installation.apiToken,
      site.artifact.id,
      chart,
      "auth-007-f-asset",
    );
    const urls = [site.links.version, site.links.artifact, asset.url];
    const cached = await Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      const etag = response.headers.get("etag") ?? "";
      const revalidated = await fetch(url, {headers: {"If-None-Match": etag}});
      return {
        cacheControl: response.headers.get("cache-control"),
        etag,
        revalidatedStatus: revalidated.status,
        status: response.status,
        url,
      };
    }));
    expect(cached).toEqual([
      // A shared cache must ask the origin again before it reuses page bytes.
      ...[site.links.version, site.links.artifact].map((url) => ({
        cacheControl: "public, no-cache, must-revalidate",
        etag: expect.stringMatching(/^"[a-f0-9]{64}"$/u),
        revalidatedStatus: 304,
        status: 200,
        url,
      })),
      // An asset revalidates like a page, so a cache asks again and is
      // refused once the artifact is private.
      {
        cacheControl: "public, no-cache, must-revalidate",
        etag: expect.stringMatching(/^"[a-f0-9]{64}"$/u),
        revalidatedStatus: 304,
        status: 200,
        url: asset.url,
      },
    ]);

    await changeAccess(site, "account_required", "auth-007-f-private");

    const probes = cached.flatMap(({etag, url}) => [
      {},
      {"If-None-Match": etag},
      {"If-None-Match": `W/${etag}`},
      {"If-None-Match": "*"},
      {Range: "bytes=0-3"},
      {"If-None-Match": etag, Range: "bytes=0-3"},
    ].map((headers: Record<string, string>) => ({headers, url})));
    const refused = await Promise.all(probes.map(async ({headers, url}) => {
      const response = await fetch(url, {headers});
      return {
        contentRange: response.headers.get("content-range"),
        etag: response.headers.get("etag"),
        headers,
        publiclyCacheable: (response.headers.get("cache-control") ?? "").includes("public"),
        status: response.status,
        url,
      };
    }));
    expect(refused).toEqual(probes.map(({headers, url}) => ({
      contentRange: null,
      etag: null,
      headers,
      publiclyCacheable: false,
      status: 401,
      url,
    })));
  });
});
