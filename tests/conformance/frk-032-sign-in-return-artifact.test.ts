import {randomUUID} from "node:crypto";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {unknownOidcUserPolicies} from "../../src/core/oidc-sign-in.js";
import {createOidcProvider} from "../../src/identity/oidc-provider.js";
import {
  type FakeOidcPerson,
  type FakeOidcProvider,
  startFakeOidcProvider,
} from "../support/fake-oidc-provider.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishSite} from "../support/same-host-site.js";

const pendingCookie = "artifact_oidc";
const alice: FakeOidcPerson = {
  email: "alice@example.com",
  email_verified: true,
  name: "Alice Example",
  sub: "alice-subject",
};

function cookiePair(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`));
}

/** The pending sign-in, as the browser holding the cookie can read it. */
function pendingSignIn(cookie: string) {
  const value = cookie.slice(`${pendingCookie}=`.length);
  return z.looseObject({returnArtifactId: z.string().nullable()}).parse(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  );
}

/** Rewrite the pending sign-in cookie's fields, as the browser holding it could. */
function editedCookie(cookie: string, edit: {readonly returnArtifactId: string}): string {
  const edited = {...pendingSignIn(cookie), ...edit};
  return `${pendingCookie}=${Buffer.from(JSON.stringify(edited)).toString("base64url")}`;
}

describe("FRK-032 sign-in from an artifact page", () => {
  let installation: TestInstallation;
  let provider: FakeOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startFakeOidcProvider();
    server = await startTestServer(installation, {
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.none, {
        provider: createOidcProvider({
          clientId: provider.clientId,
          clientSecret: Redacted.make(provider.clientSecret),
          fetch: provider.fetch,
          issuer: provider.issuer,
          redirectUri: "https://artifacts.example.com/auth/oidc/callback",
          scopes: "openid email profile",
        }),
        unknownUsers: unknownOidcUserPolicies.admit,
      }),
      contentDomain: null,
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  /** Start one sign-in, as a link on one of this server's own pages does unless `fetchSite` says otherwise. */
  async function begin(
    query: Readonly<Record<string, string>>,
    fetchSite: "cross-site" | "none" | "same-origin" | "same-site" | null = "same-origin",
  ) {
    const response = await fetch(
      `${server.baseUrl}/auth/oidc/start?${new URLSearchParams(query)}`,
      {headers: fetchSite === null ? {} : {"Sec-Fetch-Site": fetchSite}, redirect: "manual"},
    );
    expect(response.status).toBe(302);
    const cookie = cookiePair(response, pendingCookie);
    if (cookie === undefined) throw new Error("The start response set no pending sign-in cookie.");
    return {authorizationUrl: response.headers.get("location") ?? "", cookie};
  }

  /** Finish one sign-in and return where the server sends the browser. */
  async function landing(started: {readonly authorizationUrl: string; readonly cookie: string}) {
    const back = new URL(provider.approve(started.authorizationUrl, alice));
    const response = await fetch(`${server.baseUrl}/auth/oidc/callback${back.search}`, {
      headers: {Cookie: started.cookie},
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    // Every landing below is a signed-in one: only the destination differs.
    expect(cookiePair(response, "artifact_session")).toBeDefined();
    return response.headers.get("location");
  }

  async function publish(input: {
    readonly accessSetting: "account_required" | "public_link";
    readonly name: string;
    readonly path?: string;
  }) {
    return (await publishSite(server, installation, input)).artifact;
  }

  test("FRK-032-B: SSO started on this origin from a public path artifact or a public folder artifact lands on that artifact's own readable root, and SSO from the home page lands home", async () => {
    const plans = await publish({accessSetting: "public_link", name: "Team plans", path: "team/plans"});
    const folder = await publish({accessSetting: "public_link", name: "Quarterly Report"});

    expect(await landing(await begin({returnArtifact: plans.id}))).toBe("/team/plans/");
    expect(await landing(await begin({returnArtifact: folder.id})))
      .toBe(`/quarterly-report-${folder.id.slice("art_".length)}/`);
    expect(await landing(await begin({returnTo: "/"}))).toBe("/");
  });

  test("FRK-032-F: a return artifact from another site, an unknown, deleted, or private one, or a path-shaped or URL-shaped value lands on /review, a caller's query or fragment never rides along, and an edited pending cookie can only name a public artifact's own root", async () => {
    const plans = await publish({accessSetting: "public_link", name: "Team plans", path: "team/plans"});
    const privateNotes = await publish({accessSetting: "account_required", name: "Private notes"});
    const doomed = await publish({accessSetting: "public_link", name: "Doomed page", path: "doomed"});
    const deleted = await fetch(`${server.baseUrl}/api/v1/artifacts/${doomed.id}`, {
      body: JSON.stringify({expectedCurrentVersionId: doomed.currentVersionId}),
      headers: apiHeaders(installation, "delete-the-doomed-page"),
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const notArtifactIds = [
      "/team/plans/",
      "team/plans",
      "https://evil.example.com/",
      "//evil.example.com/",
      `${plans.id}/../../evil`,
      `${plans.id}?raw=1`,
      `${plans.id}#top`,
      plans.id.toUpperCase(),
      ` ${plans.id}`,
      "",
    ];
    const refused = await Promise.all(notArtifactIds.map((returnArtifact) => begin({returnArtifact})));
    // Anything that is not exactly an artifact ID is dropped before it is stored.
    expect(refused.map((each) => pendingSignIn(each.cookie).returnArtifactId))
      .toEqual(notArtifactIds.map(() => null));
    expect(await Promise.all(refused.map(landing))).toEqual(notArtifactIds.map(() => "/review"));
    // The member may read the private artifact, but its readable root serves only public ones.
    const unreachableIds = [`art_${randomUUID()}`, doomed.id, privateNotes.id];
    expect(await Promise.all(unreachableIds.map(async (returnArtifact) => landing(await begin({returnArtifact})))))
      .toEqual(["/review", "/review", "/review"]);
    // A link on another site, or a request with no Fetch Metadata, never picks the landing page.
    const offOrigin = await Promise.all((["cross-site", "same-site", "none", null] as const).map((fetchSite) =>
      begin({returnArtifact: plans.id}, fetchSite)));
    expect(offOrigin.map((each) => pendingSignIn(each.cookie).returnArtifactId)).toEqual([null, null, null, null]);
    expect(await Promise.all(offOrigin.map(landing))).toEqual(["/review", "/review", "/review", "/review"]);
    // A return path never names an artifact page; only an ID does.
    expect(await landing(await begin({returnTo: "/team/plans/"}))).toBe("/review");
    // The server's own root for the artifact, with nothing the caller sent.
    expect(await landing(await begin({raw: "1", returnArtifact: plans.id, returnTo: "/team/plans/?raw=1"})))
      .toBe("/team/plans/");

    const withEditedCookie = async (returnArtifactId: string) => {
      const started = await begin({});
      return landing({...started, cookie: editedCookie(started.cookie, {returnArtifactId})});
    };
    expect(await Promise.all(["/team/plans/", "https://evil.example.com/", doomed.id, privateNotes.id].map(withEditedCookie)))
      .toEqual(["/review", "/review", "/review", "/review"]);
    // A hand-edited ID still lands only where the server would build for it.
    expect(await withEditedCookie(plans.id)).toBe("/team/plans/");
  });
});
