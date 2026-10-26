import {describe, expect, test} from "vitest";

import {
  readSignInContext,
  signInHref,
} from "../../apps/web/src/account/sign-in-context.js";

/** The /auth/context body as a server sends it. */
interface AuthContextAnswer {
  readonly accessMode: "local_owner" | "private_team";
  readonly helpUrl: string;
  readonly login: {readonly kind: string; readonly oidc?: boolean};
}

const helpUrl = "https://help.example.com/";
const artifactId = "art_0b7c8d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";

function answering(body: AuthContextAnswer, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), {status}));
}

describe("account control sign-in context", () => {
  test("Sign in starts SSO back to the home page or to an artifact by ID when the server has OIDC, and goes to Review's gate otherwise", async () => {
    const oidc = await readSignInContext(answering({
      accessMode: "private_team",
      helpUrl,
      login: {kind: "none", oidc: true},
    }));
    expect(oidc).toEqual({helpUrl, oidc: true});
    expect(signInHref(oidc, {kind: "home"})).toBe("/auth/oidc/start?returnTo=%2F");
    expect(signInHref(oidc, {artifactId, kind: "artifact"}))
      .toBe(`/auth/oidc/start?returnArtifact=${artifactId}`);

    const gate = await readSignInContext(answering({
      accessMode: "private_team",
      helpUrl: "/team/help/",
      login: {kind: "none", oidc: false},
    }));
    expect(gate).toEqual({helpUrl: "/team/help/", oidc: false});
    expect(signInHref(gate, {artifactId, kind: "artifact"})).toBe("/review");
    // A local-owner server names no OIDC flag at all.
    const localOwner = await readSignInContext(answering({
      accessMode: "local_owner",
      helpUrl,
      login: {kind: "local_owner"},
    }));
    expect(signInHref(localOwner, {kind: "home"})).toBe("/review");
    // Before the context answers, Sign in goes to the gate.
    expect(signInHref(null, {artifactId, kind: "artifact"})).toBe("/review");
  });

  test("a failed context read or a Help link that is not https or a path on this origin is an error, not a guessed link", async () => {
    await expect(readSignInContext(answering({
      accessMode: "private_team",
      helpUrl,
      login: {kind: "none", oidc: true},
    }, 503))).rejects.toThrow("HTTP 503");
    const hostile = ["javascript:alert(1)", "http://help.example.com/", "//evil.example.com/", "/\\evil.example.com"];
    const read = await Promise.allSettled(hostile.map((link) => readSignInContext(answering({
      accessMode: "private_team",
      helpUrl: link,
      login: {kind: "none", oidc: true},
    }))));
    expect(read.map((result) => result.status)).toEqual(hostile.map(() => "rejected"));
  });
});
