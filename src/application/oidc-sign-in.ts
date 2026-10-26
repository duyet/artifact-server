import {Effect} from "effect";

import type {IssuedApplicationSession} from "../core/installation-identity.js";
import {
  oidcFailureReports,
  type OidcSignIn,
  OidcSignInFailed,
} from "../core/oidc-sign-in.js";
import {identitySecretsEqual, InstallationAccessService} from "./installation-access.js";

/** How long a browser may take between leaving for the provider and coming back. */
export const pendingOidcSignInLifetimeMilliseconds = 10 * 60_000;

/** What one browser holds between leaving for the provider and coming back. */
export interface PendingOidcSignIn {
  readonly codeVerifier: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly nonce: string;
  readonly returnTo: string;
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
  readonly returnTo: string;
}

/**
 * Begin one sign-in: the provider URL to send the browser to, and what the
 * browser must bring back. A provider failure is logged and returned.
 */
export const startOidcSignIn = Effect.fn("startOidcSignIn")(
  function*(oidc: OidcSignIn, returnTo: string, now: Date) {
    const authorization = yield* oidc.provider.authorize();
    const pending: PendingOidcSignIn = {
      codeVerifier: authorization.codeVerifier,
      expiresAt: now.getTime() + pendingOidcSignInLifetimeMilliseconds,
      nonce: authorization.nonce,
      returnTo,
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
    spentStates: SpentOidcStates,
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
    if (!spentStates.spend(pending.state, pending.expiresAt, now.getTime())) {
      return yield* failure("replayed_state", "the callback state was already used");
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
    const completed: CompletedOidcSignIn = {issued, returnTo: pending.returnTo};
    return completed;
  },
  Effect.tapError(logFailure),
);

/**
 * A Review path to return to after sign-in, or `/review` for anything else.
 * Only Review: on a server without a content domain, artifacts are served on
 * this origin and could send a freshly signed-in person somewhere else.
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
  return parsed.origin === base.origin && returnTo.length <= 1_024 &&
      (parsed.pathname === "/review" || parsed.pathname.startsWith("/review/"))
    ? returnTo
    : fallback;
}

/**
 * States this process has redeemed, kept until they expire, so one callback
 * completes at most once even when a client replays the pending cookie.
 */
export class SpentOidcStates {
  readonly #expiries = new Map<string, number>();
  readonly #maximum: number;

  constructor(maximum = 10_000) {
    this.#maximum = maximum;
  }

  /** True the first time a state is spent before it expires. */
  spend(state: string, expiresAt: number, now: number): boolean {
    for (const [spent, expiry] of this.#expiries) {
      if (expiry <= now) this.#expiries.delete(spent);
    }
    if (this.#expiries.has(state)) return false;
    if (this.#expiries.size >= this.#maximum) {
      const oldest = this.#expiries.keys().next();
      if (oldest.done !== true) this.#expiries.delete(oldest.value);
    }
    this.#expiries.set(state, expiresAt);
    return true;
  }
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
