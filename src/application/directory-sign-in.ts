import {Effect, type Redacted} from "effect";

import {
  type DirectorySignIn,
  directoryRejectionReasons,
  DirectorySignInRejected,
} from "../core/directory-sign-in.js";
import {AuthenticationRequired} from "../core/errors.js";
import {InstallationAccessService} from "./installation-access.js";

const outcomes = {
  DirectorySignInRejected: "rejected",
  DirectoryUnavailable: "unavailable",
  IdentityRepositoryFailure: "failed",
} as const;

/**
 * Verify a username and password with the directory, then issue the session
 * of the member the directory's email names. Every attempt writes one audit
 * log line with the username and outcome. The password never reaches a log.
 * Each refusal reason reaches the browser as the same 401, so a caller cannot
 * tell a wrong password from a user who has no member. A null username is one
 * the caller already refused; it is rejected without contacting the directory.
 */
export const signInWithDirectory = Effect.fn("signInWithDirectory")(function*(
  directory: DirectorySignIn,
  username: string | null,
  password: Redacted.Redacted,
) {
  if (username === null) {
    return yield* new DirectorySignInRejected({
      reason: directoryRejectionReasons.invalidUsername,
    });
  }
  const identity = yield* directory.authenticator.authenticate(username, password);
  const access = yield* InstallationAccessService;
  const issued = yield* access.loginWithDirectoryIdentity(identity, directory.unknownUsers);
  yield* Effect.logInfo("auth.directory_sign_in.succeeded").pipe(
    Effect.annotateLogs({
      member_id: issued.session.subject.kind === "member"
        ? issued.session.subject.member.id
        : null,
      username,
    }),
  );
  return issued;
}, (effect, _directory, username) =>
  effect.pipe(
    Effect.tapError((failure) =>
      Effect.logWarning(`auth.directory_sign_in.${outcomes[failure._tag]}`).pipe(
        Effect.annotateLogs({
          cause: failure._tag === "DirectoryUnavailable" ? String(failure.cause) : null,
          reason: failure._tag === "DirectorySignInRejected"
            ? failure.reason
            : failure._tag,
          username,
        }),
      )),
    Effect.catchTag("DirectorySignInRejected", () =>
      Effect.fail(new AuthenticationRequired({
        message: "The username or password was not accepted.",
      }))),
  ));
