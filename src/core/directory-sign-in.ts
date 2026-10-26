import {type Effect, type Redacted, Schema} from "effect";

import type {DirectoryUnavailable} from "./errors.js";

/** A directory user whose password the directory has just accepted. */
export interface DirectoryIdentity {
  readonly displayName: string | null;
  /** Every email value on the entry, in directory order. Never empty. */
  readonly emails: readonly [string, ...string[]];
  readonly username: string;
}

/** Why a directory sign-in was refused. Operators see it in logs; browsers never do. */
export const directoryRejectionReasons = {
  entryUnreadable: "entry_unreadable",
  invalidCredentials: "invalid_credentials",
  invalidUsername: "invalid_username",
  missingEmail: "missing_email",
  noMember: "no_member",
  notInRequiredGroup: "not_in_required_group",
} as const;

export class DirectorySignInRejected extends Schema.TaggedError<DirectorySignInRejected>()(
  "DirectorySignInRejected",
  {reason: Schema.Literals(Object.values(directoryRejectionReasons))},
) {}

/** What directory sign-in does for a user whose email matches no active member. */
export const unknownDirectoryUserPolicies = {
  admit: "admit",
  reject: "reject",
} as const;

export type UnknownDirectoryUserPolicy =
  (typeof unknownDirectoryUserPolicies)[keyof typeof unknownDirectoryUserPolicies];

/** Checks one username and password with the directory and reads that user's entry. */
export interface DirectoryAuthenticator {
  readonly authenticate: (
    username: string,
    password: Redacted.Redacted,
  ) => Effect.Effect<DirectoryIdentity, DirectorySignInRejected | DirectoryUnavailable>;
}

/** Directory sign-in as one deployment enables it. */
export interface DirectorySignIn {
  readonly authenticator: DirectoryAuthenticator;
  readonly unknownUsers: UnknownDirectoryUserPolicy;
}
