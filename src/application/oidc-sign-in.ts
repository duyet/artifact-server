import {Effect, Redacted} from "effect";

import type {IssuedApplicationSession} from "../core/installation-identity.js";
import type {ArtifactRecord} from "../core/model.js";
import {
  oidcFailureReports,
  type OidcSignIn,
  OidcSignInFailed,
} from "../core/oidc-sign-in.js";
import {AuthorizationService} from "./authorization.js";
import {ContentAccessService} from "./content-access.js";
import {identitySecretsEqual, InstallationAccessService} from "./installation-access.js";

/** How long a browser may take between leaving for the provider and coming back. */
export const pendingOidcSignInLifetimeMilliseconds = 10 * 60_000;

/** Where a browser asked to land once it is signed in. */
export interface OidcSignInReturn {
  /**
   * The artifact whose page started the sign-in. Only its ID travels; the
   * page to land on is rebuilt from the stored artifact at the callback.
   */
  readonly returnArtifactId: string | null;
  /** A Review path, used when there is no artifact or it cannot be read. */
  readonly returnTo: string;
}

/** What one browser holds between leaving for the provider and coming back. */
export interface PendingOidcSignIn extends OidcSignInReturn {
  readonly codeVerifier: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly nonce: string;
  readonly state: string;
}

/** The provider's redirect back to the callback, parsed from its query. */
export type OidcCallback =
  | {readonly code: string; readonly kind: "code"; readonly state: string}
  | {readonly error: string; readonly kind: "error"}
  | {readonly kind: "invalid"};

/** One callback as the browser delivered it. */
export interface OidcCallbackRequest {
  readonly callback: OidcCallback;
  readonly pending: PendingOidcSignIn | null;
  /** This client has failed too many callbacks recently. */
  readonly rateLimited: boolean;
}

export interface CompletedOidcSignIn {
  readonly issued: IssuedApplicationSession;
  /**
   * The return artifact, when it is live, public by link, and the new session
   * may read it: only such an artifact has a page at its readable root.
   */
  readonly returnArtifact: ArtifactRecord | null;
  readonly returnTo: string;
}

/**
 * Begin one sign-in: the provider URL to send the browser to, and what the
 * browser must bring back. A provider failure is logged and returned.
 */
export const startOidcSignIn = Effect.fn("startOidcSignIn")(
  function*(oidc: OidcSignIn, back: OidcSignInReturn, now: Date) {
    const authorization = yield* oidc.provider.authorize();
    const pending: PendingOidcSignIn = {
      codeVerifier: authorization.codeVerifier,
      expiresAt: now.getTime() + pendingOidcSignInLifetimeMilliseconds,
      nonce: authorization.nonce,
      returnArtifactId: back.returnArtifactId,
      returnTo: back.returnTo,
      state: authorization.state,
    };
    return {authorizationUrl: authorization.authorizationUrl, pending};
  },
  Effect.tapError(logFailure),
);

/**
 * Finish one sign-in from the provider's callback and the browser's pending
 * sign-in, then issue the session of the member the verified email names.
 * Every attempt writes one audit line. Codes and tokens never reach a log.
 */
export const completeOidcSignIn = Effect.fn("completeOidcSignIn")(
  function*(
    oidc: OidcSignIn,
    {callback, pending, rateLimited}: OidcCallbackRequest,
    now: Date,
  ) {
    if (rateLimited) {
      return yield* failure("rate_limited", "this client failed too many callbacks");
    }
    if (callback.kind === "error") {
      return yield* failure("provider_error", `the provider answered error=${callback.error}`);
    }
    if (callback.kind === "invalid") {
      return yield* failure("invalid_callback", "the callback carries no code and state");
    }
    if (pending === null) {
      return yield* failure("invalid_state", "this browser holds no pending sign-in");
    }
    if (!identitySecretsEqual(callback.state, pending.state)) {
      return yield* failure("invalid_state", "the callback state is not this browser's");
    }
    if (pending.expiresAt <= now.getTime()) {
      return yield* failure("expired_state", "the pending sign-in expired");
    }
    // The cookie is not signed, so an expiry past what start would set was written by hand.
    if (pending.expiresAt > now.getTime() + pendingOidcSignInLifetimeMilliseconds) {
      return yield* failure("invalid_state", "the pending sign-in claims an expiry start never sets");
    }
    const identity = yield* oidc.provider.redeem(
      callback.code,
      pending.codeVerifier,
      pending.nonce,
    );
    const access = yield* InstallationAccessService;
    const issued = yield* access.loginWithVerifiedEmail(
      identity.email,
      identity.displayName,
      oidc.unknownUsers,
    ).pipe(
      Effect.catchTag("IdentityNotFound", () =>
        failure("no_member", `no active member has the email ${identity.email}`)),
    );
    yield* Effect.logInfo("auth.oidc_sign_in.succeeded").pipe(
      Effect.annotateLogs({
        email: identity.email,
        member_id: issued.session.subject.kind === "member"
          ? issued.session.subject.member.id
          : null,
        subject: identity.subject,
      }),
    );
    const completed: CompletedOidcSignIn = {
      issued,
      returnArtifact: pending.returnArtifactId === null
        ? null
        : yield* readableReturnArtifact(issued, pending.returnArtifactId),
      returnTo: pending.returnTo,
    };
    return completed;
  },
  Effect.tapError(logFailure),
);

/**
 * The public-link artifact a new session may read, resolved as that session's
 * next request would be. Anything else, a repository failure included, is null
 * so the sign-in still lands on its Review path.
 */
const readableReturnArtifact = Effect.fn("readableReturnArtifact")(
  function*(issued: IssuedApplicationSession, artifactId: string) {
    const access = yield* InstallationAccessService;
    const content = yield* ContentAccessService;
    const session = yield* access.authenticateSession(
      Redacted.make(issued.token, {label: "application-session"}),
    );
    const artifact = yield* content.resolveReadableArtifact(session.principal, artifactId);
    const authorization = yield* AuthorizationService;
    return authorization.isPubliclyReadable(artifact.accessSetting) ? artifact : null;
  },
  Effect.tapError((failed) =>
    Effect.logInfo("auth.oidc_sign_in.return_artifact_unreadable").pipe(
      Effect.annotateLogs({reason: failed._tag}),
    )),
  Effect.orElseSucceed(() => null),
);

/**
 * A Review path or the home page to return to after sign-in, or `/review`
 * for anything else. Never an artifact path: on a server without a content
 * domain, artifacts are served on this origin and could send a freshly
 * signed-in person somewhere else. An artifact page returns by ID instead.
 */
export function safeReturnTo(value: string | undefined): string {
  const fallback = "/review";
  if (
    value === undefined || !value.startsWith("/") || value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return fallback;
  }
  const base = new URL("https://return-to.invalid");
  const parsed = new URL(value, base);
  const returnTo = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (parsed.origin !== base.origin || returnTo.length > 1_024) return fallback;
  if (returnTo === "/") return returnTo;
  return parsed.pathname === "/review" || parsed.pathname.startsWith("/review/")
    ? returnTo
    : fallback;
}

function failure(
  reason: OidcSignInFailed["reason"],
  detail: string,
): Effect.Effect<never, OidcSignInFailed> {
  return Effect.fail(new OidcSignInFailed({detail, reason}));
}

function logFailure(failed: {readonly _tag: string}): Effect.Effect<void> {
  if (!(failed instanceof OidcSignInFailed)) {
    return Effect.logError("auth.oidc_sign_in.failed").pipe(
      Effect.annotateLogs({reason: failed._tag}),
    );
  }
  return Effect.logWarning(`auth.oidc_sign_in.${oidcFailureReports[failed.reason].outcome}`).pipe(
    Effect.annotateLogs({detail: failed.detail, reason: failed.reason}),
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) return true;
  }
  return false;
}
