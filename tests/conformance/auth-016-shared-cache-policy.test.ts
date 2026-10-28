import {createHash} from "node:crypto";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const privatePage = "<!doctype html><title>Private payroll</title>";
const privateStyles = "body { color: payroll-purple; }";
const bootstrapSchema = z.object({bootstrapUrl: z.url()});

interface StoredResponse {
  readonly body: string;
  readonly cacheControl: string;
  readonly etag: string | null;
  readonly status: number;
}

/**
 * A shared cache that follows the RFC 9111 storage and reuse rules the
 * origin's headers select: it never stores `private` or `no-store`, reuses a
 * fresh `max-age` response without asking the origin, and revalidates a
 * `no-cache` response with its ETag before reusing it.
 */
class SharedCache {
  readonly #entries = new Map<string, StoredResponse>();
  readonly #server: RunningTestServer;
  #originRequests = 0;

  constructor(server: RunningTestServer) {
    this.#server = server;
  }

  get originRequests(): number {
    return this.#originRequests;
  }

  stored(url: string): boolean {
    return this.#entries.has(url);
  }

  async fetch(url: string, headers: Record<string, string> = {}): Promise<StoredResponse> {
    const stored = this.#entries.get(url);
    if (stored !== undefined && isFresh(stored.cacheControl)) return stored;
    const conditional = stored?.etag === null || stored === undefined
      ? headers
      : {...headers, "If-None-Match": stored.etag};
    this.#originRequests += 1;
    const response = await fetchVersion(this.#server, url, "GET", conditional);
    if (response.status === 304 && stored !== undefined) return stored;
    const fresh: StoredResponse = {
      body: await response.text(),
      cacheControl: response.headers.get("cache-control") ?? "",
      etag: response.headers.get("etag"),
      status: response.status,
    };
    if (fresh.status === 200 && sharedCacheMayStore(fresh.cacheControl)) {
      this.#entries.set(url, fresh);
    } else {
      this.#entries.delete(url);
    }
    return fresh;
  }
}

function directives(cacheControl: string): Set<string> {
  return new Set(cacheControl.split(",").map((part) => part.trim().toLowerCase()));
}

function sharedCacheMayStore(cacheControl: string): boolean {
  const parsed = directives(cacheControl);
  return !parsed.has("no-store") && !parsed.has("private");
}

function isFresh(cacheControl: string): boolean {
  const parsed = directives(cacheControl);
  return !parsed.has("no-cache") &&
    [...parsed].some((directive) => /^max-age=[1-9]\d*$/u.test(directive));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("shared cache policy for private and public content", () => {
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

  async function publishPrivateSite(): Promise<PublishResponse> {
    const files: readonly TestSiteFile[] = [
      {
        bytes: new TextEncoder().encode(privatePage),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
      {
        bytes: new TextEncoder().encode(privateStyles),
        mediaType: "text/css; charset=utf-8",
        path: "styles/site.css",
      },
    ];
    const planned = await createStagedUpload(server, installation, "index.html", files);
    const uploads = await uploadEveryStagedFile(installation, planned.body, files);
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    const published = await commitStagedUpload(
      installation,
      planned.body,
      "auth-016-private-site",
      {accessSetting: "account_required", kind: "new_artifact", name: "Payroll"},
    );
    expect(published.response.status).toBe(201);
    return published.body;
  }

  async function contentCookie(artifactId: string): Promise<string> {
    const issued = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(issued.status).toBe(201);
    const exchange = await fetchVersion(
      server,
      bootstrapSchema.parse(await issued.json()).bootstrapUrl,
    );
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The content session set no cookie.");
    return cookie;
  }

  test("AUTH-016-B: private content is private, no-store on every delivery form, and the current public version is publicly cacheable under its immutable version key", async () => {
    const site = await publishPrivateSite();
    const cookie = await contentCookie(site.artifact.id);
    const entryUrl = site.links.version;
    const stylesUrl = new URL("styles/site.css", entryUrl).href;
    const page = await fetchVersion(server, entryUrl, "GET", {Cookie: cookie});
    expect(page.status).toBe(200);
    const pageEtag = page.headers.get("etag") ?? "";
    const forms = [
      {headers: {}, label: "page", method: "GET", status: 200, url: entryUrl},
      {headers: {}, label: "styles", method: "GET", status: 200, url: stylesUrl},
      {headers: {}, label: "head", method: "HEAD", status: 200, url: entryUrl},
      {headers: {Range: "bytes=0-3"}, label: "range", method: "GET", status: 206, url: stylesUrl},
      {
        headers: {"If-None-Match": pageEtag},
        label: "revalidation",
        method: "GET",
        status: 304,
        url: entryUrl,
      },
    ];
    const delivered = await Promise.all(forms.map(async ({headers, label, method, url}) => {
      const response = await fetchVersion(server, url, method, {...headers, Cookie: cookie});
      return {
        cacheControl: response.headers.get("cache-control"),
        label,
        status: response.status,
      };
    }));
    expect(delivered).toEqual(forms.map(({label, status}) => ({
      cacheControl: "private, no-store",
      label,
      status,
    })));

    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Public one</title>",
      idempotencyKey: "auth-016-public-first",
      name: "Public notes",
    });
    const publicFirst = await fetchVersion(server, published.body.links.version);
    expect(publicFirst.status).toBe(200);
    expect(publicFirst.headers.get("cache-control")).toBe(
      "public, no-cache, must-revalidate",
    );
    // The public key names one immutable version: its ETag is the bytes' digest.
    expect(publicFirst.headers.get("etag")).toBe(
      `"${sha256("<!doctype html><title>Public one</title>")}"`,
    );

    const second = await publishVersion(server, installation, {
      artifactId: published.body.artifact.id,
      content: "<!doctype html><title>Public two</title>",
      expectedCurrentVersionId: published.body.version.id,
      idempotencyKey: "auth-016-public-second",
    });
    expect(second.response.status).toBe(201);
    const publicSecond = await fetchVersion(server, second.body.links.version);
    expect(publicSecond.status).toBe(200);
    expect(publicSecond.headers.get("cache-control")).toBe(
      "public, no-cache, must-revalidate",
    );
    // The earlier version key no longer answers publicly once it is not current.
    const earlier = await fetchVersion(server, published.body.links.version);
    expect(earlier.status).toBe(401);
    expect(earlier.headers.get("cache-control") ?? "").not.toContain("public");
  });

  test("AUTH-016-F: an anonymous viewer gets no private bytes from a shared cache another viewer populated", async () => {
    const site = await publishPrivateSite();
    const cookie = await contentCookie(site.artifact.id);
    const cache = new SharedCache(server);
    const entryUrl = site.links.version;
    const stylesUrl = new URL("styles/site.css", entryUrl).href;

    expect((await cache.fetch(entryUrl, {Cookie: cookie})).body).toBe(privatePage);
    expect((await cache.fetch(stylesUrl, {Cookie: cookie})).body).toBe(privateStyles);
    expect(cache.stored(entryUrl)).toBe(false);
    expect(cache.stored(stylesUrl)).toBe(false);

    const anonymous = await Promise.all([entryUrl, stylesUrl].map(async (url) => {
      const response = await cache.fetch(url);
      return {leaked: response.body.includes("payroll"), status: response.status, url};
    }));
    expect(anonymous).toEqual([entryUrl, stylesUrl].map((url) => ({
      leaked: false,
      status: 401,
      url,
    })));

    // Public bytes the cache holds stop reaching anyone once the artifact is private.
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Soon private</title>",
      idempotencyKey: "auth-016-public-then-private",
      name: "Soon private",
    });
    const url = published.body.links.version;
    expect((await cache.fetch(url)).status).toBe(200);
    expect(cache.stored(url)).toBe(true);
    const changed = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "auth-016-make-private"),
        method: "PATCH",
      },
    );
    expect(changed.status).toBe(200);
    const before = cache.originRequests;
    const afterChange = await cache.fetch(url);
    expect(cache.originRequests).toBe(before + 1);
    expect(afterChange.status).toBe(401);
    expect(afterChange.body).not.toContain("Soon private");
    expect(cache.stored(url)).toBe(false);
  });
});
