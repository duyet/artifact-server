import {createHash, randomBytes} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {text} from "node:stream/consumers";

import {exportJWK, generateKeyPair, SignJWT, UnsecuredJWT} from "jose";
import {z} from "zod";

const issuer = "https://sso.example.com";
const clientId = "artifact-server";
const clientSecret = "fake client secret with + and & in it";

/** The person the fake provider signs in, as ID token claims. */
export interface FakeOidcPerson {
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly name?: string;
  readonly sub: string;
}

/** Every ID token claim a test may set, or remove with undefined. */
interface IdTokenClaims {
  readonly aud?: string | readonly string[] | undefined;
  readonly azp?: string | undefined;
  readonly email?: string | undefined;
  readonly email_verified?: boolean | string | undefined;
  readonly exp?: number | undefined;
  readonly iat?: number | undefined;
  readonly iss?: string | undefined;
  readonly name?: string | undefined;
  readonly nonce?: string | undefined;
  readonly sub?: string | undefined;
}

/** How one issued ID token departs from a correct one. */
export interface IdTokenTampering {
  /** Claims merged over the correct ones. An undefined value removes the claim. */
  readonly claims?: IdTokenClaims;
  /** `stranger` signs with a key the JWKS does not hold, under the provider's key ID. */
  readonly signing?: "none" | "provider" | "stranger";
}

/** One request the token endpoint received, as the server sent it. */
export interface TokenRequest {
  readonly authorization: string | undefined;
  readonly body: Readonly<Record<string, string>>;
}

export interface FakeOidcProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Reaches the fake for any URL on its issuer origin, like the network would. */
  readonly fetch: typeof globalThis.fetch;
  readonly issuer: string;
  readonly tokenRequests: readonly TokenRequest[];
  /** Approve one authorization request and return the URL the provider redirects to. */
  approve(authorizationUrl: string, person: FakeOidcPerson, tampering?: IdTokenTampering): string;
  /** Answer the redirect with an OAuth error instead of a code. */
  deny(authorizationUrl: string, error: string): string;
  stop(): Promise<void>;
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly person: FakeOidcPerson;
  readonly redirectUri: string;
  readonly tampering: IdTokenTampering;
}

const addressSchema = z.object({port: z.number().int().positive()});
const authorizationRequestSchema = z.object({
  client_id: z.literal(clientId),
  code_challenge: z.string().regex(/^[\w-]{43}$/u),
  code_challenge_method: z.literal("S256"),
  nonce: z.string().min(16),
  redirect_uri: z.string().min(1),
  response_type: z.literal("code"),
  scope: z.string().refine((scope) => scope.split(" ").includes("openid")),
  state: z.string().min(16),
});

/**
 * An OpenID Connect provider on a loopback port with discovery, a JWKS, and
 * a token endpoint that checks client authentication and PKCE. Codes are not
 * single use here, so a replayed callback is refused by the server itself.
 */
export async function startFakeOidcProvider(): Promise<FakeOidcProvider> {
  const keys = await generateKeyPair("RS256");
  const strangerKeys = await generateKeyPair("RS256");
  const publicKey = {...await exportJWK(keys.publicKey), alg: "RS256", kid: "provider-key", use: "sig"};
  const codes = new Map<string, IssuedCode>();
  const tokenRequests: TokenRequest[] = [];

  const idToken = async (issued: IssuedCode): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const claims = Object.fromEntries(Object.entries({
      aud: clientId,
      exp: now + 300,
      iat: now,
      iss: issuer,
      nonce: issued.nonce,
      ...issued.person,
      ...issued.tampering.claims,
    }).filter(([, value]) => value !== undefined));
    const signing = issued.tampering.signing ?? "provider";
    if (signing === "none") return new UnsecuredJWT(claims).encode();
    return new SignJWT(claims)
      .setProtectedHeader({alg: "RS256", kid: "provider-key", typ: "JWT"})
      .sign(signing === "provider" ? keys.privateKey : strangerKeys.privateKey);
  };

  const token = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = Object.fromEntries(new URLSearchParams(await text(request)));
    tokenRequests.push({authorization: request.headers.authorization, body});
    if (!presentsClientCredentials(request.headers.authorization)) {
      return json(response, 401, JSON.stringify({error: "invalid_client"}));
    }
    const issued = codes.get(body["code"] ?? "");
    if (
      body["grant_type"] !== "authorization_code" || issued === undefined ||
      body["redirect_uri"] !== issued.redirectUri ||
      sha256Base64Url(body["code_verifier"] ?? "") !== issued.codeChallenge
    ) {
      return json(response, 400, JSON.stringify({error: "invalid_grant"}));
    }
    return json(response, 200, JSON.stringify({
      access_token: "fake-access-token",
      id_token: await idToken(issued),
      token_type: "Bearer",
    }));
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return json(response, 200, JSON.stringify({
        authorization_endpoint: `${issuer}/auth`,
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        token_endpoint: `${issuer}/token`,
      }));
    }
    if (request.method === "GET" && path === "/keys") {
      return json(response, 200, JSON.stringify({keys: [publicKey]}));
    }
    if (request.method === "POST" && path === "/token") {
      void token(request, response);
      return undefined;
    }
    return json(response, 404, JSON.stringify({error: "not_found"}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const loopback = `http://127.0.0.1:${addressSchema.parse(server.address()).port}`;

  const authorizationRequest = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${issuer}/auth`) {
      throw new Error(`Not this provider's authorization endpoint: ${url.origin}${url.pathname}`);
    }
    return authorizationRequestSchema.parse(Object.fromEntries(url.searchParams));
  };

  return {
    approve(authorizationUrl, person, tampering = {}) {
      const request = authorizationRequest(authorizationUrl);
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        codeChallenge: request.code_challenge,
        nonce: request.nonce,
        person,
        redirectUri: request.redirect_uri,
        tampering,
      });
      const callback = new URL(request.redirect_uri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", request.state);
      return callback.toString();
    },
    clientId,
    clientSecret,
    deny(authorizationUrl, error) {
      const request = authorizationRequest(authorizationUrl);
      const callback = new URL(request.redirect_uri);
      callback.searchParams.set("error", error);
      callback.searchParams.set("state", request.state);
      return callback.toString();
    },
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== issuer) throw new TypeError(`The fake provider does not serve ${url.origin}.`);
      return globalThis.fetch(`${loopback}${url.pathname}${url.search}`, init);
    },
    issuer,
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
    tokenRequests,
  };
}

function json(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {"Content-Type": "application/json"});
  response.end(body);
}

function formDecode(value: string): string | null {
  return new URLSearchParams(`value=${value}`).get("value");
}

/** client_secret_basic as RFC 6749 section 2.3.1 decodes it. */
function presentsClientCredentials(authorization: string | undefined): boolean {
  if (authorization?.startsWith("Basic ") !== true) return false;
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator !== -1 &&
    formDecode(decoded.slice(0, separator)) === clientId &&
    formDecode(decoded.slice(separator + 1)) === clientSecret;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
