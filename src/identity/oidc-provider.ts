import {createHash, randomBytes} from "node:crypto";

import {Effect, Redacted} from "effect";
import {createLocalJWKSet, jwtVerify} from "jose";
import {z} from "zod";

import {
  type OidcFailureReason,
  type OidcIdentity,
  type OidcProvider,
  OidcSignInFailed,
} from "../core/oidc-sign-in.js";

/** One confidential client registered with one OpenID Connect provider. */
export interface OidcProviderConfiguration {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  /** Every request to the provider goes through it. Tests point it at a fake provider. */
  readonly fetch?: typeof globalThis.fetch;
  /** An https URL without a trailing slash. */
  readonly issuer: string;
  readonly redirectUri: string;
  readonly scopes: string;
}

interface OidcDiscovery {
  readonly authorizationEndpoint: string;
  /** The issuer exactly as the provider spells it, which is what `iss` must equal. */
  readonly issuer: string;
  readonly jwksUri: string;
  readonly tokenEndpoint: string;
}

const discoveryPath = "/.well-known/openid-configuration";
const requestTimeoutMilliseconds = 5_000;
const idTokenClockTolerance = "30s";
const idTokenMaximumAge = "10m";
const signingAlgorithms = [
  "ES256", "ES384", "ES512", "EdDSA", "Ed25519",
  "PS256", "PS384", "PS512", "RS256", "RS384", "RS512",
];

const discoveryDocumentSchema = z.looseObject({
  authorization_endpoint: z.string().min(1),
  issuer: z.string().min(1),
  jwks_uri: z.string().min(1),
  token_endpoint: z.string().min(1),
});
const keySetSchema = z.looseObject({keys: z.array(z.looseObject({}))});
const tokenResponseSchema = z.looseObject({id_token: z.string().min(1)});
const idTokenClaimsSchema = z.looseObject({
  azp: z.string().optional(),
  email: z.string().trim().min(1).optional(),
  email_verified: z.unknown().optional(),
  family_name: z.string().optional(),
  given_name: z.string().optional(),
  name: z.string().optional(),
  nonce: z.string().optional(),
  sub: z.string().min(1),
});
type IdTokenClaims = z.infer<typeof idTokenClaimsSchema>;

/** The authorization code flow with PKCE against one provider, verified with jose. */
export function createOidcProvider(configuration: OidcProviderConfiguration): OidcProvider {
  const providerFetch = configuration.fetch ?? globalThis.fetch;
  let discovered: OidcDiscovery | null = null;

  const discovery = (): Effect.Effect<OidcDiscovery, OidcSignInFailed> =>
    discovered === null
      ? loadDiscovery(configuration.issuer, providerFetch).pipe(
        Effect.tap((loaded) => Effect.sync(() => {
          discovered = loaded;
        })),
      )
      : Effect.succeed(discovered);

  return {
    authorize: () => discovery().pipe(Effect.map((endpoints) => {
      const state = randomBase64Url(32);
      const nonce = randomBase64Url(32);
      const codeVerifier = randomBase64Url(32);
      const url = new URL(endpoints.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", configuration.clientId);
      url.searchParams.set("redirect_uri", configuration.redirectUri);
      url.searchParams.set("scope", configuration.scopes);
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      return {authorizationUrl: url.toString(), codeVerifier, nonce, state};
    })),
    redeem: (code, codeVerifier, nonce) => Effect.gen(function*() {
      const endpoints = yield* discovery();
      const idToken = yield* exchangeCode(configuration, endpoints, code, codeVerifier, providerFetch);
      const keys = yield* readJson(providerFetch, endpoints.jwksUri, "JWKS", keySetSchema);
      const keySet = yield* Effect.try({
        catch: () => fail("provider_unavailable", "the JWKS holds no usable key set"),
        try: () => createLocalJWKSet({keys: keys.keys}),
      });
      const payload = yield* Effect.tryPromise({
        catch: (cause) => fail("invalid_id_token", errorMessage(cause)),
        try: async () => (await jwtVerify(idToken, keySet, {
          algorithms: signingAlgorithms,
          audience: configuration.clientId,
          clockTolerance: idTokenClockTolerance,
          issuer: endpoints.issuer,
          maxTokenAge: idTokenMaximumAge,
          requiredClaims: ["exp", "sub"],
        })).payload,
      });
      const claims = idTokenClaimsSchema.safeParse(payload);
      if (!claims.success) {
        return yield* fail("invalid_id_token", "the ID token claims have the wrong shape");
      }
      if (claims.data.azp !== undefined && claims.data.azp !== configuration.clientId) {
        return yield* fail("invalid_id_token", "the ID token was issued to another client");
      }
      if (claims.data.nonce !== nonce) {
        return yield* fail("nonce_mismatch", "the ID token nonce is not this sign-in's");
      }
      return yield* identityFromClaims(claims.data);
    }),
  };
}

const loadDiscovery = Effect.fn("OidcProvider.loadDiscovery")(function*(
  issuer: string,
  providerFetch: typeof globalThis.fetch,
) {
  const document = yield* readJson(
    providerFetch,
    `${issuer}${discoveryPath}`,
    "discovery document",
    discoveryDocumentSchema,
  );
  if (document.issuer.replace(/\/+$/u, "") !== issuer) {
    return yield* fail("provider_unavailable", "the discovery document names another issuer");
  }
  const endpoints = [
    document.authorization_endpoint,
    document.token_endpoint,
    document.jwks_uri,
  ];
  if (!endpoints.every(isHttpsUrl)) {
    return yield* fail("provider_unavailable", "the discovery document has a non-https endpoint");
  }
  const discovered: OidcDiscovery = {
    authorizationEndpoint: document.authorization_endpoint,
    issuer: document.issuer,
    jwksUri: document.jwks_uri,
    tokenEndpoint: document.token_endpoint,
  };
  return discovered;
});

const exchangeCode = Effect.fn("OidcProvider.exchangeCode")(function*(
  configuration: OidcProviderConfiguration,
  endpoints: OidcDiscovery,
  code: string,
  codeVerifier: string,
  providerFetch: typeof globalThis.fetch,
) {
  const credentials = `${formEncode(configuration.clientId)}:${
    formEncode(Redacted.value(configuration.clientSecret))
  }`;
  const response = yield* send(providerFetch, endpoints.tokenEndpoint, "token endpoint", {
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: configuration.redirectUri,
    }),
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (response.status >= 400 && response.status < 500) {
    return yield* fail("token_rejected", `the token endpoint answered HTTP ${response.status}`);
  }
  const tokens = yield* parsedJson(
    response,
    tokenResponseSchema,
    fail("token_rejected", "the token response has no id_token"),
  );
  return tokens.id_token;
});

function identityFromClaims(claims: IdTokenClaims): Effect.Effect<OidcIdentity, OidcSignInFailed> {
  if (claims.email === undefined) {
    return Effect.fail(fail("missing_email", "the ID token has no email claim"));
  }
  // Some providers send the boolean as a string. Anything else present is not a yes.
  if (
    claims.email_verified !== undefined &&
    claims.email_verified !== true && claims.email_verified !== "true"
  ) {
    return Effect.fail(fail("email_unverified", "the provider has not verified the email"));
  }
  return Effect.succeed({
    displayName: displayName(claims),
    email: claims.email,
    subject: claims.sub,
  });
}

function displayName(claims: IdTokenClaims): string | null {
  const name = claims.name?.trim() ?? "";
  const parts = [claims.given_name, claims.family_name]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "");
  const chosen = name === "" ? parts.join(" ") : name;
  return chosen === "" || chosen.length > 200 ? null : chosen;
}

function readJson<T>(
  providerFetch: typeof globalThis.fetch,
  url: string,
  label: string,
  schema: z.ZodType<T>,
): Effect.Effect<T, OidcSignInFailed> {
  return send(providerFetch, url, label, {headers: {Accept: "application/json"}}).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? parsedJson(response, schema, fail("provider_unavailable", `the ${label} is malformed`))
        : Effect.fail(fail("provider_unavailable", `the ${label} answered HTTP ${response.status}`))),
  );
}

/** One bounded request that never follows a redirect off the validated endpoint. */
function send(
  providerFetch: typeof globalThis.fetch,
  url: string,
  label: string,
  init: RequestInit,
): Effect.Effect<Response, OidcSignInFailed> {
  return Effect.tryPromise({
    catch: (cause) => fail(
      "provider_unavailable",
      cause instanceof Error && cause.name === "TimeoutError"
        ? `the ${label} did not answer within ${requestTimeoutMilliseconds / 1_000} s`
        : `the ${label} could not be reached: ${errorMessage(cause)}`,
    ),
    try: (signal) => providerFetch(url, {
      ...init,
      // A followed redirect would replay the client secret and the code to an unvalidated host.
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]),
    }),
  }).pipe(
    Effect.flatMap((response) =>
      response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) ||
        response.status >= 500
        ? Effect.fail(fail("provider_unavailable", `the ${label} answered HTTP ${response.status}`))
        : Effect.succeed(response)),
  );
}

function parsedJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  malformed: OidcSignInFailed,
): Effect.Effect<T, OidcSignInFailed> {
  return Effect.tryPromise({
    catch: () => malformed,
    try: async () => schema.parse(await response.json()),
  });
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

/** application/x-www-form-urlencoded, which client_secret_basic requires (RFC 6749 section 2.3.1). */
function formEncode(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown error";
}

function fail(reason: OidcFailureReason, detail: string): OidcSignInFailed {
  return new OidcSignInFailed({detail, reason});
}
