import {Effect, Redacted, Schema} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {z} from "zod";

import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";

const storedCredentialSchema = z.object({
  apiKey: z.string().min(32).max(4_096),
  kind: z.literal("api_key"),
  schemaVersion: z.literal(1),
}).strict();
const principalSchema = Schema.Struct({
  authorizedByPrincipalId: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(Schema.Literals([
    principalCapabilities.connectAgents,
    principalCapabilities.createArtifact,
    principalCapabilities.issueContentSession,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.manageProjects,
    principalCapabilities.publishAnyArtifact,
    principalCapabilities.readArtifacts,
    principalCapabilities.writeComments,
  ])),
  displayName: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("Agent")),
  ),
  id: Schema.String,
  installationId: Schema.String,
  kind: Schema.Literals([principalKinds.human, principalKinds.service]),
  membershipRole: Schema.Literals([
    membershipRoles.administrator,
    membershipRoles.member,
  ]),
});
const sessionResponseSchema = Schema.Struct({
  authenticationMethod: Schema.Literals(["bearer", "session"]),
  principal: principalSchema,
});

/** Expected failure while decoding or verifying a saved CLI credential. */
export class CliAuthenticationError extends Schema.TaggedError<CliAuthenticationError>()(
  "CliAuthenticationError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "credential_invalid",
      "credential_revoked",
      "invalid_metadata",
      "server_unavailable",
    ]),
  },
) {}

/** Scoped API key persisted behind a profile identifier as one operating-system credential. */
export type StoredCliCredential = z.infer<typeof storedCredentialSchema>;

/** Verified account information returned by one exact Artifact Server. */
export interface VerifiedCliAccount {
  readonly principal: Principal;
}

/** Build a stored scoped API-key credential. */
export function apiKeyCredential(apiKey: string): StoredCliCredential {
  return storedCredentialSchema.parse({
    apiKey,
    kind: "api_key",
    schemaVersion: 1,
  });
}

/** Encode one profile secret for the operating-system credential store. */
export function encodeStoredCliCredential(
  credential: StoredCliCredential,
): Redacted.Redacted {
  return Redacted.make(JSON.stringify(storedCredentialSchema.parse(credential)), {
    label: "artifact-server-cli-profile",
  });
}

/** Decode one opaque operating-system credential without exposing it in errors. */
export function decodeStoredCliCredential(
  credential: Redacted.Redacted,
): Effect.Effect<StoredCliCredential, CliAuthenticationError> {
  return Effect.try({
    try: () => storedCredentialSchema.parse(
      JSON.parse(Redacted.value(credential)),
    ),
    catch: () => new CliAuthenticationError({
      message: "The saved Artifact Server CLI credential is invalid.",
      reason: "credential_invalid",
    }),
  });
}

/** Return the current bearer without copying it into profile metadata. */
export function bearerFromStoredCredential(
  credential: StoredCliCredential,
): Redacted.Redacted {
  return Redacted.make(credential.apiKey, {label: "artifact-server-cli-bearer"});
}

/** Verify a bearer against the remote server rather than trusting local claims. */
export const verifyCliCredential = Effect.fn("CliAuthentication.verifyCredential")(
  function*(
    origin: string,
    bearer: Redacted.Redacted,
  ): Effect.fn.Return<
    VerifiedCliAccount,
    CliAuthenticationError,
    HttpClient.HttpClient
  > {
    const request = HttpClientRequest.get(
      new URL("/api/v1/session", origin),
    ).pipe(HttpClientRequest.bearerToken(bearer));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() => new CliAuthenticationError({
        message: `Artifact Server at ${origin} could not be reached.`,
        reason: "server_unavailable",
      })),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new CliAuthenticationError({
        message: "The saved Artifact Server credential is invalid or no longer active.",
        reason: "credential_revoked",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliAuthenticationError({
        message: `Artifact Server rejected credential inspection with HTTP ${response.status}.`,
        reason: "server_unavailable",
      });
    }
    const decoded = yield* HttpClientResponse.schemaBodyJson(
      sessionResponseSchema,
    )(response).pipe(
      Effect.mapError(() => new CliAuthenticationError({
        message: "Artifact Server returned an invalid credential-inspection response.",
        reason: "invalid_metadata",
      })),
    );
    return {principal: decoded.principal};
  },
);
