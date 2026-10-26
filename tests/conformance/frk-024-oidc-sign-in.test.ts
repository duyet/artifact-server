import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {
  type UnknownOidcUserPolicy,
  unknownOidcUserPolicies,
} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "../support/agent-dispatch.js";
import {
  type FakeOidcPerson,
  type FakeOidcProvider,
  type IdTokenTampering,
  startFakeOidcProvider,
} from "../support/fake-oidc-provider.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const redirectUri = "https://artifacts.example.com/auth/oidc/callback";
const pendingCookie = "artifact_oidc";
const alice: FakeOidcPerson = {
  email: "Alice@Example.COM",
  email_verified: true,
  name: "Alice Example",
  sub: "alice-subject",
};
const newcomer: FakeOidcPerson = {
  email: "newcomer@example.com",
  email_verified: true,
  name: "New Comer",
  sub: "newcomer-subject",
};
const dave: FakeOidcPerson = {email: "dave@example.com", sub: "dave-subject"};

const principalSchema = z.object({
  principal: z.object({
    displayName: z.string(),
    id: z.string(),
    kind: z.string(),
    membershipRole: z.string(),
  }).loose(),
});

interface StartedSignIn {
  readonly authorizationUrl: string;
  /** The pending sign-in cookie, as a `Cookie` header pair. */
  readonly cookie: string;
}

function cookiePair(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`));
}

function sessionCookies(response: Response): string | null {
  const session = cookiePair(response, "artifact_session");
  const csrf = cookiePair(response, "artifact_csrf");
  return session === undefined || csrf === undefined ? null : `${session}; ${csrf}`;
}

const pendingSignInSchema = z.looseObject({});

/** Rewrite one field of a pending sign-in cookie, as a client holding it could. */
function editedCookie(
  cookie: string,
  edit: {readonly codeVerifier?: string; readonly expiresAt?: number; readonly returnTo?: string},
): string {
  const value = cookie.slice(`${pendingCookie}=`.length);
  const pending = pendingSignInSchema.parse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
  return `${pendingCookie}=${Buffer.from(JSON.stringify({...pending, ...edit})).toString("base64url")}`;
}

describe("OIDC browser sign-in", () => {
  let installation: TestInstallation;
  let provider: FakeOidcProvider;
  let clock: MutableClock;
  let server: RunningTestServer | undefined;

  const running = (): RunningTestServer => {
    if (server === undefined) throw new Error("The test server is not running.");
    return server;
  };

  async function seedMember(
    member: {readonly email: string; readonly id: string},
    deactivated = false,
  ): Promise<void> {
    const repository = new SqliteIdentityRepository(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      await repository.admitMember({
        ...member,
        createdAt: "2026-10-26T00:00:00.000Z",
        displayName: member.email,
        installationId: "local",
        role: "member",
      });
      if (deactivated) {
        await repository.deactivateMember("local", member.id, "2026-10-26T00:00:01.000Z");
      }
    } finally {
      repository.close();
    }
  }

  async function memberEmails(): Promise<readonly string[]> {
    const repository = new SqliteIdentityRepository(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      return (await repository.listMembers("local")).map((member) => member.email).toSorted();
    } finally {
      repository.close();
    }
  }

  async function start(options: {
    readonly observability?: boolean;
    readonly unknownUsers?: UnknownOidcUserPolicy;
  } = {}): Promise<RunningTestServer> {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        provider: createOidcProvider({
          clientId: provider.clientId,
          clientSecret: Redacted.make(provider.clientSecret),
          fetch: provider.fetch,
          issuer: provider.issuer,
          redirectUri,
          scopes: "openid email profile",
        }),
        unknownUsers: options.unknownUsers ?? unknownOidcUserPolicies.reject,
      }),
      clock,
      contentDomain: null,
      observability: options.observability ?? false,
    });
    return server;
  }

  async function begin(returnTo?: string): Promise<StartedSignIn> {
    const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    const response = await fetch(`${running().baseUrl}/auth/oidc/start${query}`, {redirect: "manual"});
    expect(response.status).toBe(302);
    const cookie = cookiePair(response, pendingCookie);
    if (cookie === undefined) throw new Error("The start response set no pending sign-in cookie.");
    return {authorizationUrl: response.headers.get("location") ?? "", cookie};
  }

  /** Follow the provider's redirect back to this server's callback with one cookie header. */
  function callback(providerRedirect: string, cookie: string | null): Promise<Response> {
    const url = new URL(providerRedirect);
    return fetch(`${running().baseUrl}/auth/oidc/callback${url.search}`, {
      headers: cookie === null ? {} : {Cookie: cookie},
      redirect: "manual",
    });
  }

  async function signIn(
    person: FakeOidcPerson,
    tampering?: IdTokenTampering,
    returnTo?: string,
  ): Promise<Response> {
    const started = await begin(returnTo);
    return callback(provider.approve(started.authorizationUrl, person, tampering), started.cookie);
  }

  async function principal(cookies: string) {
    const response = await fetch(`${running().baseUrl}/api/v1/session`, {headers: {Cookie: cookies}});
    expect(response.status).toBe(200);
    return principalSchema.parse(await response.json()).principal;
  }

  function expectRefused(response: Response, outcome: "failed" | "unavailable" = "failed"): void {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/review?sso=${outcome}`);
    expect(sessionCookies(response)).toBeNull();
  }

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock();
    // The private-team bootstrap key must exist before any member does.
    await (await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    })).stop();
    provider = await startFakeOidcProvider();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop();
    server = undefined;
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("FRK-024-B: a member signs in with SSO as the member their verified email names and lands on their return path", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    const context = await fetch(`${running().baseUrl}/auth/context`);
    expect(await context.json()).toEqual({
      accessMode: "private_team",
      login: {kind: "none", oidc: true},
    });

    const startResponse = await fetch(
      `${running().baseUrl}/auth/oidc/start?returnTo=${encodeURIComponent("/review/settings/api-keys?tab=mine")}`,
      {redirect: "manual"},
    );
    expect(startResponse.status).toBe(302);
    expect(startResponse.headers.get("cache-control")).toBe("private, no-store");
    const pendingSetCookie = startResponse.headers.getSetCookie()
      .find((cookie) => cookie.startsWith(`${pendingCookie}=`));
    expect(pendingSetCookie).toMatch(/; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/u);
    const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${provider.issuer}/auth`);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid email profile");

    const providerRedirect = provider.approve(authorizationUrl.toString(), alice);
    const response = await callback(providerRedirect, cookiePair(startResponse, pendingCookie) ?? null);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/review/settings/api-keys?tab=mine");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(cookiePair(response, pendingCookie)).toBe(`${pendingCookie}=`);
    const cookies = sessionCookies(response);
    if (cookies === null) throw new Error("The callback set no session.");
    expect(await principal(cookies)).toMatchObject({
      id: "member_alice",
      kind: "human",
      membershipRole: "member",
    });
    expect(provider.tokenRequests).toHaveLength(1);
    expect(provider.tokenRequests[0]?.body).toMatchObject({
      code: new URL(providerRedirect).searchParams.get("code"),
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
  });

  test("admit creates one member for a new verified email and reuses it on the next sign-in", async () => {
    await start({unknownUsers: unknownOidcUserPolicies.admit});
    const first = sessionCookies(await signIn(newcomer));
    const second = sessionCookies(await signIn({...newcomer, email: "NewComer@Example.com"}));
    if (first === null || second === null) throw new Error("An admitted sign-in set no session.");
    const admitted = await principal(first);
    expect(admitted).toMatchObject({displayName: "New Comer", membershipRole: "member"});
    expect((await principal(second)).id).toBe(admitted.id);
    expect((await memberEmails()).filter((email) => email === "newcomer@example.com")).toHaveLength(1);
  });

  test("FRK-024-F: an unknown email, a deactivated member, an unverified email, and a missing email are refused without a session", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await seedMember({email: "dave@example.com", id: "member_dave"}, true);
    await start();
    expectRefused(await signIn(newcomer));
    expectRefused(await signIn(dave));
    expectRefused(await signIn({...alice, email_verified: false}));
    expectRefused(await signIn({...alice, email_verified: "false"}));
    expectRefused(await signIn({sub: "no-email-subject"}));
    expect(await memberEmails()).toEqual(["alice@example.com", "dave@example.com"]);
  });

  test("admit never revives a deactivated member or admits an unverified email", async () => {
    await seedMember({email: "dave@example.com", id: "member_dave"}, true);
    await start({unknownUsers: unknownOidcUserPolicies.admit});
    expectRefused(await signIn(dave));
    expectRefused(await signIn({...newcomer, email_verified: false}));
    expect(await memberEmails()).toEqual(["dave@example.com"]);
  });

  test("a callback without this browser's pending sign-in, for another state, expired, edited, or replayed never redeems a new code", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();

    const started = await begin();
    const redirect = provider.approve(started.authorizationUrl, alice);
    expectRefused(await callback(redirect, null));
    const other = await begin();
    expectRefused(await callback(redirect, other.cookie));
    expectRefused(await callback(redirect, `${pendingCookie}=not-base64-json`));
    expectRefused(await callback(redirect, editedCookie(started.cookie, {codeVerifier: "short"})));
    expectRefused(await callback(redirect, editedCookie(started.cookie, {expiresAt: 9e15})));
    expect(provider.tokenRequests).toHaveLength(0);

    const completed = await callback(redirect, started.cookie);
    expect(sessionCookies(completed)).not.toBeNull();
    expectRefused(await callback(redirect, started.cookie));
    expect(provider.tokenRequests).toHaveLength(1);

    const expiring = await begin();
    const expiringRedirect = provider.approve(expiring.authorizationUrl, alice);
    clock.advance(10 * 60_000 + 1);
    expectRefused(await callback(expiringRedirect, expiring.cookie));
    expect(provider.tokenRequests).toHaveLength(1);
  });

  test("an ID token with another nonce, audience, issuer, or client, an expired or future one, a stranger's signature, or alg none is refused", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    const now = Math.floor(Date.now() / 1_000);
    const tamperings: readonly IdTokenTampering[] = [
      {claims: {nonce: "a-nonce-from-another-sign-in"}},
      {claims: {nonce: undefined}},
      {claims: {aud: "another-client"}},
      {claims: {aud: ["artifact-server", "another-client"], azp: "another-client"}},
      {claims: {aud: ["artifact-server", "another-client"]}},
      {claims: {iss: "https://sso.example.org"}},
      {claims: {exp: now - 120, iat: now - 600}},
      {claims: {iat: now - 3_600, exp: now + 300}},
      {claims: {iat: now + 600, exp: now + 900}},
      {claims: {exp: undefined}},
      {signing: "stranger"},
      {signing: "none"},
      {signing: "client_secret"},
    ];
    for (const response of await Promise.all(tamperings.map((tampering) => signIn(alice, tampering)))) {
      expectRefused(response);
    }
    expect(provider.tokenRequests).toHaveLength(tamperings.length);
    expect(sessionCookies(await signIn(alice))).not.toBeNull();
  });

  test("the provider's error and a callback with no code are refused", async () => {
    await start();
    const started = await begin();
    expectRefused(await callback(provider.deny(started.authorizationUrl, "access_denied"), started.cookie));
    const bare = await begin();
    expectRefused(await callback(`${redirectUri}?state=only-a-state-and-nothing-else`, bare.cookie));
    expect(provider.tokenRequests).toHaveLength(0);
  });

  test("a return path off this origin falls back to /review, whether it arrives in the query or an edited cookie", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    const hostile = [
      "/team/an-artifact-page/",
      "/reviewer",
      "https://evil.example.com/review",
      "//evil.example.com/review",
      "/\\evil.example.com",
      "/..//evil.example.com",
      "javascript:alert(1)",
      "/review\r\nSet-Cookie: x=y",
    ];
    for (const response of await Promise.all(hostile.map((returnTo) => signIn(alice, {}, returnTo)))) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/review");
    }
    const started = await begin("/review");
    const response = await callback(
      provider.approve(started.authorizationUrl, alice),
      editedCookie(started.cookie, {returnTo: "//evil.example.com/"}),
    );
    expect(response.headers.get("location")).toBe("/review");
  });

  test("a client that fails 20 callbacks in a minute is refused before the provider is asked, and a success costs nothing", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    expect(sessionCookies(await signIn(alice))).not.toBeNull();
    const bare = await Promise.all(Array.from({length: 20}, () =>
      callback(`${redirectUri}?code=x&state=a-state-nobody-started`, null)));
    for (const response of bare) expectRefused(response);
    expectRefused(await signIn(alice));
    expect(provider.tokenRequests).toHaveLength(1);
    clock.advance(60_000);
    expect(sessionCookies(await signIn(alice))).not.toBeNull();
  });

  test("an ASCII member is never matched by an email that only lowercases to theirs", async () => {
    await seedMember({email: "kate@example.com", id: "member_kate"});
    await start();
    expectRefused(await signIn({email: "\u212Aate@example.com", email_verified: true, sub: "kelvin"}));
    expect(sessionCookies(await signIn({email: "Kate@example.com", sub: "kate"}))).not.toBeNull();
  });

  test("a token endpoint that redirects is SSO unavailable, and the code never follows the redirect", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    provider.redirectTokenRequests = true;
    expectRefused(await signIn(alice), "unavailable");
    expect(provider.tokenRequests).toHaveLength(1);
  });

  test("an unreachable provider is SSO unavailable at start and at the callback", async () => {
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start();
    const started = await begin();
    const redirect = provider.approve(started.authorizationUrl, alice);
    await provider.stop();
    expectRefused(await callback(redirect, started.cookie), "unavailable");

    await server?.stop();
    await start();
    const response = await fetch(`${running().baseUrl}/auth/oidc/start`, {redirect: "manual"});
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/review?sso=unavailable");
    expect(cookiePair(response, pendingCookie)).toBeUndefined();
    provider = await startFakeOidcProvider();
  });

  test("each attempt writes one audit line with its outcome, and no line holds a code or the client secret", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
    await seedMember({email: "alice@example.com", id: "member_alice"});
    await start({observability: true});
    const succeeded = await begin();
    const succeededRedirect = provider.approve(succeeded.authorizationUrl, alice);
    expect(sessionCookies(await callback(succeededRedirect, succeeded.cookie))).not.toBeNull();
    expectRefused(await signIn(newcomer));
    expectRefused(await signIn(alice, {claims: {nonce: "a-nonce-from-another-sign-in"}}));

    const audit = lines.filter((line) => line.includes("auth.oidc_sign_in."));
    expect(audit).toHaveLength(3);
    expect(audit[0]).toContain("auth.oidc_sign_in.succeeded");
    expect(audit[0]).toContain("member_alice");
    expect(audit[1]).toContain("auth.oidc_sign_in.rejected");
    expect(audit[1]).toContain("no_member");
    expect(audit[2]).toContain("auth.oidc_sign_in.failed");
    expect(audit[2]).toContain("nonce_mismatch");
    const code = new URL(succeededRedirect).searchParams.get("code") ?? "";
    for (const line of lines) {
      expect(line).not.toContain(code);
      expect(line).not.toContain(provider.clientSecret);
    }
  });

  test("a server without OIDC sign-in has no OIDC routes and reports none", async () => {
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
      contentDomain: null,
    });
    expect(await (await fetch(`${running().baseUrl}/auth/context`)).json()).toEqual({
      accessMode: "private_team",
      login: {kind: "none", oidc: false},
    });
    const routes = ["/auth/oidc/start", "/auth/oidc/callback?code=x&state=yyyyyyyyyyyyyyyy"];
    const responses = await Promise.all(routes.map((route) =>
      fetch(`${running().baseUrl}${route}`, {redirect: "manual"})));
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });
});

describe("OIDC sign-in configuration", () => {
  const base: NodeJS.ProcessEnv = {
    ARTIFACT_SERVER_API_TOKEN:
      `as_key_key_00000000-0000-4000-8000-000000000000_${"a".repeat(40)}`,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
    ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-key",
    ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access-key",
  };
  const oidc = {
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
    ARTIFACT_SERVER_OIDC_CLIENT_SECRET: "a client secret",
    ARTIFACT_SERVER_OIDC_ISSUER: "https://sso.example.com/",
  };

  const parse = (environment: NodeJS.ProcessEnv) =>
    Effect.runPromise(parseExternalStorageRuntimeConfiguration({
      environment: {...base, ...environment},
      hostname: "127.0.0.1",
      port: "8787",
    }));

  test("OIDC sign-in is off without an issuer, and on with safe defaults when one is set", async () => {
    expect((await parse({})).oidcSignIn).toBeNull();
    const configured = await parse(oidc);
    expect(configured.oidcSignIn).toMatchObject({
      clientId: "artifact-server",
      issuer: "https://sso.example.com",
      redirectUri: "https://artifacts.example.com/auth/oidc/callback",
      scopes: "openid email profile",
      unknownUsers: "reject",
    });
    expect(Redacted.value(configured.oidcSignIn?.clientSecret.value ?? Redacted.make(""))).toBe("a client secret");
    const summary = summarizeRuntimeConfiguration(configured).oidcSignIn;
    expect(summary).toEqual({
      clientId: "artifact-server",
      clientSecret: "environment",
      issuer: "https://sso.example.com",
      redirectUri: "https://artifacts.example.com/auth/oidc/callback",
      scopes: "openid email profile",
      unknownUsers: "reject",
    });
    expect(JSON.stringify(summary)).not.toContain("a client secret");

    const directory = await mkdtemp(path.join(tmpdir(), "artifact-server-oidc-"));
    try {
      const secretFile = path.join(directory, "client-secret");
      await writeFile(secretFile, "a file secret\n");
      const fromFile = await parse({
        ...oidc,
        ARTIFACT_SERVER_OIDC_CLIENT_SECRET: undefined,
        ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE: secretFile,
        ARTIFACT_SERVER_OIDC_SCOPES: "openid email groups",
        ARTIFACT_SERVER_OIDC_UNKNOWN_USERS: "admit",
      });
      expect(fromFile.oidcSignIn).toMatchObject({
        scopes: "openid email groups",
        unknownUsers: "admit",
      });
      expect(Redacted.value(fromFile.oidcSignIn?.clientSecret.value ?? Redacted.make(""))).toBe("a file secret");
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  test("a clear-text or decorated issuer, a missing client, a missing or doubled secret, scopes without openid, and an unknown policy are refused at startup", async () => {
    const refused = (environment: NodeJS.ProcessEnv) =>
      expect(parse({...oidc, ...environment})).rejects.toMatchObject({
        reason: expect.stringMatching(/^(conflicting_secret_sources|invalid_value|missing_value)$/u),
      });
    await refused({ARTIFACT_SERVER_OIDC_ISSUER: "http://sso.example.com"});
    await refused({ARTIFACT_SERVER_OIDC_ISSUER: "https://user:pass@sso.example.com"});
    await refused({ARTIFACT_SERVER_OIDC_ISSUER: "https://sso.example.com/?tenant=x"});
    await refused({ARTIFACT_SERVER_OIDC_ISSUER: "not a url"});
    await refused({ARTIFACT_SERVER_OIDC_CLIENT_ID: undefined});
    await refused({ARTIFACT_SERVER_OIDC_CLIENT_ID: "has space"});
    await refused({ARTIFACT_SERVER_OIDC_CLIENT_SECRET: undefined});
    await refused({ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE: "/nonexistent/secret"});
    await refused({ARTIFACT_SERVER_OIDC_SCOPES: "email profile"});
    await refused({ARTIFACT_SERVER_OIDC_SCOPES: "openid  email"});
    await refused({ARTIFACT_SERVER_OIDC_UNKNOWN_USERS: "maybe"});
  });
});
