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
  apiPost,
  publishSite,
  spaShell,
} from "../support/same-host-site.js";

/** The sandbox of `/v/<token>/`, which Review leases share. */
const sandboxPolicy =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
/** The folder and path forms load in the viewer's frame, so a click may navigate the tab. */
const readablePolicy = `${sandboxPolicy} allow-top-navigation-by-user-activation`;
const previewLeaseSchema = z.object({baseUrl: z.url()});
const navigation = {
  Accept: "text/html",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
};
/** A navigation of the viewer's frame, the way a browser loads a readable URL's page. */
const frameNavigation = {
  Accept: "text/html",
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
};

interface ContentRequest {
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly name: string;
  /** A folder or path URL, which the viewer frames. */
  readonly readable?: true;
  readonly status: number;
  readonly url: string;
}

describe("same-host content sandbox", () => {
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

  test("FRK-002-B: every same-host content response, in both path forms, carries the sandbox policy and Access-Control-Allow-Origin", async () => {
    const pub = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Sandbox public",
    });
    const spa = await publishSite(server, installation, {
      accessSetting: "public_link",
      entry: spaShell,
      name: "Sandbox SPA",
      routingMode: "spa",
    });
    const priv = await publishSite(server, installation, {
      accessSetting: "account_required",
      name: "Sandbox private",
    });
    const pathSite = await publishSite(server, installation, {
      accessSetting: "public_link",
      name: "Sandbox path",
      path: "2026/10/sandbox-path",
    });
    const leaseResponse = await apiPost(
      installation,
      `${server.baseUrl}/api/v1/artifacts/${priv.artifact.id}/versions/${priv.version.id}/preview-leases?projectId=${priv.artifact.projectId}`,
    );
    const lease = previewLeaseSchema.parse(await leaseResponse.json());

    const base = `${server.baseUrl}/v/${pub.version.contentToken}`;
    const stylesheetUrl = `${base}/assets/a.css`;
    const etag = (await fetchVersion(server, stylesheetUrl)).headers.get("etag");
    if (etag === null) throw new Error("The stylesheet response has no ETag.");

    const requests: readonly ContentRequest[] = [
      {name: "200 entry", status: 200, url: `${base}/`},
      {
        headers: {Range: "bytes=0-3"},
        name: "206 range",
        status: 206,
        url: stylesheetUrl,
      },
      {
        headers: {"If-None-Match": etag},
        name: "304 not modified",
        status: 304,
        url: stylesheetUrl,
      },
      {name: "404 missing file", status: 404, url: `${base}/missing.html`},
      {
        name: "401 private version",
        status: 401,
        url: `${server.baseUrl}/v/${priv.version.contentToken}/`,
      },
      {method: "HEAD", name: "HEAD", status: 200, url: stylesheetUrl},
      {name: "308 missing slash", status: 308, url: base},
      {
        headers: navigation,
        name: "200 SPA fallback",
        status: 200,
        url: `${server.baseUrl}/v/${spa.version.contentToken}/settings/profile`,
      },
      {
        headers: {Range: "bytes=9999-"},
        name: "416 unsatisfiable range",
        status: 416,
        url: stylesheetUrl,
      },
      {method: "POST", name: "405 write", status: 405, url: `${base}/`},
      {
        name: "501 bootstrap through the error handler",
        status: 501,
        url: `${server.baseUrl}/v/${priv.version.contentToken}/?__artifact_bootstrap=${"a".repeat(43)}`,
      },
      {
        name: "404 unknown token",
        status: 404,
        url: `${server.baseUrl}/v/${"0".repeat(36)}/`,
      },
      {name: "404 malformed token", status: 404, url: `${server.baseUrl}/v/short/`},
      {name: "200 Review lease", status: 200, url: lease.baseUrl},
      {name: "200 folder entry", readable: true, status: 200, url: pub.links.artifact},
      {
        name: "308 folder stale name",
        readable: true,
        status: 308,
        url: `${server.baseUrl}/stale-name-${pub.artifact.id.slice("art_".length)}/`,
      },
      {
        name: "308 folder missing slash",
        readable: true,
        status: 308,
        url: pub.links.artifact.slice(0, -1),
      },
      {name: "401 private folder", readable: true, status: 401, url: priv.links.artifact},
      {
        name: "404 folder missing file",
        readable: true,
        status: 404,
        url: `${pub.links.artifact}missing.html`,
      },
      {
        name: "404 unknown folder artifact",
        readable: true,
        status: 404,
        url: `${server.baseUrl}/folder-3fa85f64-5717-4562-b3fc-2c963f66afa6/`,
      },
      {
        headers: frameNavigation,
        name: "200 folder SPA fallback",
        readable: true,
        status: 200,
        url: `${spa.links.artifact}settings/profile`,
      },
      {name: "200 path entry", readable: true, status: 200, url: pathSite.links.artifact},
      {
        name: "404 path missing file",
        readable: true,
        status: 404,
        url: `${pathSite.links.artifact}missing.html`,
      },
    ];
    const observed = await Promise.all(requests.map(async (request) => {
      const response = await fetchVersion(
        server,
        request.url,
        request.method,
        request.headers,
      );
      return {
        credentials: response.headers.get("access-control-allow-credentials"),
        name: request.name,
        origin: response.headers.get("access-control-allow-origin"),
        policy: response.headers.get("content-security-policy"),
        status: response.status,
      };
    }));
    expect(observed).toEqual(requests.map((request) => ({
      credentials: null,
      name: request.name,
      origin: "*",
      policy: request.readable ? readablePolicy : sandboxPolicy,
      status: request.status,
    })));

    const applicationRoutes = await Promise.all([
      `${server.baseUrl}/health`,
      `${server.baseUrl}/api/v1/session`,
      `${server.baseUrl}/not-a-route.txt`,
    ].map(async (url) => {
      const response = await fetch(url);
      return {
        origin: response.headers.get("access-control-allow-origin"),
        policy: response.headers.get("content-security-policy"),
        status: response.status,
      };
    }));
    expect(applicationRoutes).toEqual([
      {origin: null, policy: null, status: 200},
      {origin: null, policy: null, status: 401},
      {origin: null, policy: null, status: 404},
    ]);
  });
});
