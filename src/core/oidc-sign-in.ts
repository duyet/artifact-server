import {type Effect, Schema} from "effect";

/** What OIDC sign-in does with a verified email that names no active member. */
export const unknownOidcUserPolicies = {
  admit: "admit",
  reject: "reject",
} as const;

export type UnknownOidcUserPolicy =
  (typeof unknownOidcUserPolicies)[keyof typeof unknownOidcUserPolicies];

const oidcFailureReasonValues = [
  "email_unverified",
  "expired_state",
  "invalid_callback",
  "invalid_id_token",
  "invalid_state",
  "missing_email",
  "no_member",
  "nonce_mismatch",
  "provider_error",
  "provider_unavailable",
  "rate_limited",
  "replayed_state",
  "token_rejected",
] as const;

/** Why one OIDC sign-in ended without a session. Operators read it in logs. */
export type OidcFailureReason = (typeof oidcFailureReasonValues)[number];

/** How one failure reason is logged and what the browser is told. */
export interface OidcFailureReport {
  /** The browser learns only whether the provider was unavailable. */
  readonly browser: "failed" | "unavailable";
  /** `rejected`: the provider vouched for someone this server refuses. */
  readonly outcome: "failed" | "rejected";
}

const failed: OidcFailureReport = {browser: "failed", outcome: "failed"};
const rejected: OidcFailureReport = {browser: "failed", outcome: "rejected"};

export const oidcFailureReports = {
  email_unverified: rejected,
  expired_state: failed,
  invalid_callback: failed,
  invalid_id_token: failed,
  invalid_state: failed,
  missing_email: rejected,
  no_member: rejected,
  nonce_mismatch: failed,
  provider_error: failed,
  provider_unavailable: {browser: "unavailable", outcome: "failed"},
  rate_limited: failed,
  replayed_state: failed,
  token_rejected: failed,
} as const satisfies Readonly<Record<OidcFailureReason, OidcFailureReport>>;

export class OidcSignInFailed extends Schema.TaggedError<OidcSignInFailed>()(
  "OidcSignInFailed",
  {
    /** Operator-facing detail. It never holds a code, token, or secret. */
    detail: Schema.String,
    reason: Schema.Literals(oidcFailureReasonValues),
  },
) {}

/** The person a verified ID token names. */
export interface OidcIdentity {
  readonly displayName: string | null;
  /** The ID token's `email` claim, as the provider sent it. */
  readonly email: string;
  readonly subject: string;
}

/** One authorization request and the secrets that later complete it. */
export interface OidcAuthorization {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly state: string;
}

/** An OpenID Connect provider reached with the authorization code flow. */
export interface OidcProvider {
  readonly authorize: () => Effect.Effect<OidcAuthorization, OidcSignInFailed>;
  readonly redeem: (
    code: string,
    codeVerifier: string,
    nonce: string,
  ) => Effect.Effect<OidcIdentity, OidcSignInFailed>;
}

/** OIDC sign-in as one deployment enables it. */
export interface OidcSignIn {
  readonly provider: OidcProvider;
  readonly unknownUsers: UnknownOidcUserPolicy;
}
