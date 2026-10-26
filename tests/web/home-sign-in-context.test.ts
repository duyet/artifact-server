import {describe, expect, test} from "vitest";

import {readSignInContext} from "../../apps/web/src/home/home-client.js";

/** The /auth/context body as a server sends it. */
interface AuthContextAnswer {
  readonly accessMode: "local_owner" | "private_team";
  readonly helpUrl: string | null;
  readonly login: {readonly kind: string; readonly oidc?: boolean};
}

function answering(body: AuthContextAnswer, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), {status}));
}

describe("home page sign-in context", () => {
  test("Sign in starts SSO and returns home when the server has OIDC, and goes to Review's gate otherwise", async () => {
    const helpUrl = "https://help.example.com/";
    await expect(readSignInContext(answering({
      accessMode: "private_team",
      helpUrl,
      login: {kind: "none", oidc: true},
    }))).resolves.toEqual({helpUrl, signInHref: "/auth/oidc/start?returnTo=%2F"});
    await expect(readSignInContext(answering({
      accessMode: "private_team",
      helpUrl: null,
      login: {kind: "none", oidc: false},
    }))).resolves.toEqual({helpUrl: null, signInHref: "/review"});
    // A local-owner server names no OIDC flag at all.
    await expect(readSignInContext(answering({
      accessMode: "local_owner",
      helpUrl: null,
      login: {kind: "local_owner"},
    }))).resolves.toEqual({helpUrl: null, signInHref: "/review"});
  });

  test("a failed context read is an error, not a guessed sign-in route", async () => {
    await expect(readSignInContext(answering({
      accessMode: "private_team",
      helpUrl: null,
      login: {kind: "none", oidc: true},
    }, 503))).rejects.toThrow("HTTP 503");
  });
});
