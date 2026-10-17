import {createHash} from "node:crypto";
import path from "node:path";

import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {InteractiveIdentityProvider} from "../../src/application/interactive-login.js";
import {
  browserLoginKinds,
  localOwnerBrowserAccess,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {IdentityProviderFailure} from "../../src/core/errors.js";
import {principalCapabilities} from "../../src/core/identity.js";
import type {Clock} from "../../src/core/ports.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const sessionSchema = z.object({
  authenticationMethod: z.enum(["bearer", "session"]),
  principal: z.unknown(),
});
const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}),
  token: z.string(),
});
const forgedKey =
  "as_key_key_00000000-0000-4000-8000-000000000001_wrongSecretWithSufficientEntropy123456";

const unusedProvider: InteractiveIdentityProvider = {
  complete: () => Effect.fail(new IdentityProviderFailure({message: "unused"})),
  name: "unused-provider",
  start: () => Effect.fail(new IdentityProviderFailure({message: "unused"})),
};

class MutableClock implements Clock {
  #milliseconds = new Date("2026-10-17T08:00:00.000Z").getTime();

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}

interface BrowserCookies {
  readonly csrf: string;
  readonly header: string;
}

function sameOriginHeaders(server: RunningTestServer) {
  return {
    "Content-Type": "application/json",
    Origin: server.baseUrl,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function signIn(
  server: RunningTestServer,
  apiKey: string,
  headers: Record<string, string> = sameOriginHeaders(server),
): Promise<Response> {
  return fetch(`${server.baseUrl}/auth/api-key`, {
    body: JSON.stringify({apiKey}),
    headers,
    method: "POST",
  });
}

function failedSignIns(server: RunningTestServer, count: number): Promise<number[]> {
  return Promise.all(
    Array.from({length: count}, async () => (await signIn(server, forgedKey)).status),
  );
}

function browserCookies(response: Response): BrowserCookies {
  const pairs = response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0] ?? "");
  const session = pairs.find((pair) => pair.startsWith("artifact_session="));
  const csrf = pairs.find((pair) => pair.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The sign-in response did not set both application cookies.");
  }
  return {csrf: csrf.slice("artifact_csrf=".length), header: `${session}; ${csrf}`};
}

function cookieMutation(server: RunningTestServer, cookies: BrowserCookies) {
  return {
    ...sameOriginHeaders(server),
    Cookie: cookies.header,
    "X-CSRF-Token": cookies.csrf,
  };
}

async function sessionWithCookie(
  server: RunningTestServer,
  cookies: BrowserCookies,
): Promise<{readonly body: unknown; readonly status: number}> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: cookies.header},
  });
  return {body: await response.json(), status: response.status};
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Seed a human administrator session, since a no-login server has no admin sign-in. */
async function seedAdministratorSession(
  installation: TestInstallation,
  clock: MutableClock,
): Promise<BrowserCookies> {
  const repository = new SqliteIdentityRepository(
    path.join(installation.dataDirectory, "artifact-server.db"),
  );
  const token = "administrator-session-token-for-api-key-revocation";
  const csrf = "administrator-csrf-token-for-api-key-revocation-test";
  try {
    const member = await repository.admitMember({
      createdAt: clock.now().toISOString(),
      displayName: "Administrator",
      email: "administrator@example.test",
      id: "member_seeded_administrator",
      installationId: "local",
      role: "administrator",
    });
    await repository.createApplicationSession({
      createdAt: clock.now().toISOString(),
      csrfDigest: digest(csrf),
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
      id: "session_seeded_administrator",
      installationId: "local",
      subject: {kind: "member", memberId: member.id},
      tokenDigest: digest(token),
    });
  } finally {
    repository.close();
  }
  return {csrf, header: `artifact_session=${token}; artifact_csrf=${csrf}`};
}

describe("API-key browser sign-in", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | undefined;
  let clock: MutableClock;

  const running = (): RunningTestServer => {
    if (server === undefined) throw new Error("The test server is not running.");
    return server;
  };

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock();
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      clock,
      contentDomain: null,
    });
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await removeTestInstallation(installation);
  });

  test("AUTH-029-B: a valid key signs the browser in as that key, and sign-out revokes the session", async () => {
    const response = await signIn(running(), installation.apiToken);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookies = response.headers.getSetCookie();
    const sessionCookie = setCookies.find((cookie) => cookie.startsWith("artifact_session="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    const cookies = browserCookies(response);

    const bearer = await fetch(`${running().baseUrl}/api/v1/session`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    const bearerPrincipal = sessionSchema.parse(await bearer.json()).principal;
    const session = await sessionWithCookie(running(), cookies);
    expect(session.status).toBe(200);
    expect(sessionSchema.parse(session.body)).toEqual({
      authenticationMethod: "session",
      principal: bearerPrincipal,
    });

    const logout = await fetch(`${running().baseUrl}/api/v1/session/logout`, {
      headers: cookieMutation(running(), cookies),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect((await sessionWithCookie(running(), cookies)).status).toBe(401);
  });

  test("AUTH-029-F: a wrong key, a cross-site request, or a server with browser login gets no session", async () => {
    const wrongKey = await signIn(running(), forgedKey);
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.headers.getSetCookie()).toEqual([]);
    const notAKey = await signIn(running(), "not-an-artifact-server-key");
    expect(notAKey.status).toBe(401);
    expect(errorSchema.parse(await notAKey.json()).error).toEqual(
      errorSchema.parse(await wrongKey.json()).error,
    );

    const crossSite = await Promise.all([
      {...sameOriginHeaders(running()), Origin: "https://attacker.example"},
      {...sameOriginHeaders(running()), Origin: "null"},
      {...sameOriginHeaders(running()), "Sec-Fetch-Site": "cross-site"},
    ].map(async (headers) => {
      const response = await signIn(running(), installation.apiToken, headers);
      return {cookies: response.headers.getSetCookie(), status: response.status};
    }));
    expect(crossSite).toEqual([
      {cookies: [], status: 403},
      {cookies: [], status: 403},
      {cookies: [], status: 403},
    ]);

    const fromQuery = await fetch(
      `${running().baseUrl}/auth/api-key?apiKey=${installation.apiToken}`,
      {headers: sameOriginHeaders(running()), method: "POST"},
    );
    expect(fromQuery.status).toBe(400);
    expect(fromQuery.headers.getSetCookie()).toEqual([]);

    await running().stop();
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      clock,
      contentDomain: null,
      interactiveIdentityProvider: unusedProvider,
    });
    const withOidc = await signIn(running(), installation.apiToken);
    expect(withOidc.status).toBe(404);
    expect(withOidc.headers.getSetCookie()).toEqual([]);

    await running().stop();
    server = await startTestServer(installation, {
      browserAccess: localOwnerBrowserAccess,
      clock,
    });
    expect((await signIn(running(), installation.apiToken)).status).toBe(404);
  });

  test("AUTH-030-F: revoking the key ends the browser session it signed in at once", async () => {
    const administrator = await seedAdministratorSession(installation, clock);
    const issued = await fetch(`${running().baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: [principalCapabilities.readArtifacts],
        expiresAt: "2027-01-01T00:00:00.000Z",
        name: "Reviewer laptop",
      }),
      headers: cookieMutation(running(), administrator),
      method: "POST",
    });
    expect(issued.status).toBe(201);
    const key = issuedKeySchema.parse(await issued.json());

    const signedIn = await signIn(running(), key.token);
    expect(signedIn.status).toBe(204);
    const cookies = browserCookies(signedIn);
    expect((await sessionWithCookie(running(), cookies)).status).toBe(200);

    const revoked = await fetch(
      `${running().baseUrl}/api/v1/api-keys/${key.apiKey.id}/revoke`,
      {headers: cookieMutation(running(), administrator), method: "POST"},
    );
    expect(revoked.status).toBe(200);
    expect((await sessionWithCookie(running(), cookies)).status).toBe(401);
    expect((await signIn(running(), key.token)).status).toBe(401);
  });

  test("AUTH-031-F: the sixth failed sign-in in one minute is refused before the key is checked", async () => {
    expect(await failedSignIns(running(), 5)).toEqual([401, 401, 401, 401, 401]);

    const limited = await signIn(running(), forgedKey);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(errorSchema.parse(await limited.json()).error.code).toBe("RATE_LIMITED");

    clock.advance(30_000);
    const validKeyWhileLimited = await signIn(running(), installation.apiToken);
    expect(validKeyWhileLimited.status).toBe(429);
    expect(validKeyWhileLimited.headers.get("retry-after")).toBe("30");
    expect(validKeyWhileLimited.headers.getSetCookie()).toEqual([]);
  });

  test("AUTH-031-B: after the window a valid key signs in, and a success clears the failure count", async () => {
    await failedSignIns(running(), 5);
    expect((await signIn(running(), forgedKey)).status).toBe(429);
    clock.advance(60_000);
    expect((await signIn(running(), installation.apiToken)).status).toBe(204);

    expect(await failedSignIns(running(), 4)).toEqual([401, 401, 401, 401]);
    expect((await signIn(running(), installation.apiToken)).status).toBe(204);
    expect(await failedSignIns(running(), 4)).toEqual([401, 401, 401, 401]);
    expect((await signIn(running(), forgedKey)).status).toBe(401);
  });

  test("AUTH-032-B: artifact content served beside a key session stays in an opaque sandbox", async () => {
    const signedIn = await signIn(running(), installation.apiToken);
    expect(signedIn.status).toBe(204);
    const cookies = browserCookies(signedIn);
    const site = await publishSite(running(), installation, {
      accessSetting: "public_link",
      name: "Key session sandbox",
    });

    const content = await fetch(site.links.artifact, {headers: {Cookie: cookies.header}});
    expect(content.status).toBe(200);
    const policy = content.headers.get("content-security-policy") ?? "";
    expect(policy.split(";").map((directive) => directive.trim().split(" ")[0]))
      .toContain("sandbox");
    expect(policy).not.toContain("allow-same-origin");
  });

  test("AUTH-032-F: a key session cannot be used for a mutation from an opaque or cross-site origin", async () => {
    const signedIn = await signIn(running(), installation.apiToken);
    const cookies = browserCookies(signedIn);

    const attempts = await Promise.all([
      {...cookieMutation(running(), cookies), Origin: "null"},
      {...cookieMutation(running(), cookies), "Sec-Fetch-Site": "cross-site"},
    ].map(async (headers) =>
      (await fetch(`${running().baseUrl}/api/v1/session/logout`, {
        headers,
        method: "POST",
      })).status
    ));
    expect(attempts).toEqual([403, 403]);
    expect((await sessionWithCookie(running(), cookies)).status).toBe(200);
  });
});
