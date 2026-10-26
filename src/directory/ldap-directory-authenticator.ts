import type {ConnectionOptions} from "node:tls";

import {Effect, Redacted} from "effect";
import {Client, type ClientOptions, type Entry, ResultCodeError} from "ldapts";

import {
  type DirectoryAuthenticator,
  type DirectoryIdentity,
  directoryRejectionReasons,
  DirectorySignInRejected,
} from "../core/directory-sign-in.js";
import {DirectoryUnavailable} from "../core/errors.js";

/** One LDAP directory that browser sign-in binds to as the signing-in user. */
export interface LdapDirectoryConfiguration {
  /** PEM bundle that replaces the default trust store, or null for the default. */
  readonly caCertificates: string | null;
  readonly displayNameAttribute: string;
  readonly emailAttribute: string;
  readonly requiredGroupDn: string | null;
  readonly timeoutMilliseconds: number;
  readonly url: string;
  /** A DN with `{username}` as exactly one attribute value. */
  readonly userDnTemplate: string;
}

const usernamePlaceholder = "{username}";

// Bind results that mean the directory refused these credentials, as opposed
// to the directory being busy, unreachable, or misconfigured.
const credentialRefusalCodes = new Set([
  19, // constraintViolation: 389-DS answers a locked account with it
  32, // noSuchObject
  34, // invalidDNSyntax
  48, // inappropriateAuthentication
  49, // invalidCredentials
  50, // insufficientAccessRights
  53, // unwillingToPerform: an inactive FreeIPA account
]);

type EntryRead =
  | {readonly kind: "refused"}
  | {readonly kind: "unreadable"}
  | {readonly kind: "read"; readonly entry: Entry | undefined};

/** Directory sign-in by a simple bind as the user, with no service account. */
export function createLdapDirectoryAuthenticator(
  configuration: LdapDirectoryConfiguration,
): DirectoryAuthenticator {
  return {
    authenticate: (username, password) => {
      const secret = Redacted.value(password);
      // A simple bind with an empty password is an unauthenticated bind,
      // which succeeds without proving anything (RFC 4513 section 5.1.2).
      if (username === "" || secret === "") {
        return Effect.fail(rejected(directoryRejectionReasons.invalidCredentials));
      }
      return Effect.tryPromise({
        catch: (cause) => new DirectoryUnavailable({
          cause,
          message: "The directory could not verify the sign-in. Try again later.",
        }),
        try: () => bindAndRead(
          configuration,
          userDn(configuration.userDnTemplate, username),
          secret,
        ),
      }).pipe(
        Effect.flatMap((read) =>
          read.kind === "read"
            ? identityFromEntry(configuration, username, read.entry)
            : Effect.fail(rejected(
              read.kind === "refused"
                ? directoryRejectionReasons.invalidCredentials
                : directoryRejectionReasons.entryUnreadable,
            ))),
      );
    },
  };
}

/** Escape one attribute value for a distinguished name (RFC 4514 section 2.4). */
function escapeDnValue(value: string): string {
  return value.replaceAll(
    /[\\"+,;<>\0]|^[ #]| $/gu,
    (character) => (character === "\0" ? "\\00" : `\\${character}`),
  );
}

function userDn(template: string, username: string): string {
  // A replacer function, because a replacement string would expand `$&`.
  return template.replace(usernamePlaceholder, () => escapeDnValue(username));
}

async function bindAndRead(
  configuration: LdapDirectoryConfiguration,
  dn: string,
  password: string,
): Promise<EntryRead> {
  const options: ClientOptions = {
    connectTimeout: configuration.timeoutMilliseconds,
    timeout: configuration.timeoutMilliseconds,
    url: configuration.url,
  };
  // ldapts speaks TLS whenever it has TLS options, even to an ldap:// URL.
  const client = new Client(new URL(configuration.url).protocol === "ldaps:"
    ? {...options, tlsOptions: tlsOptions(configuration.caCertificates)}
    : options);
  try {
    try {
      await client.bind(dn, password);
    } catch (error) {
      if (error instanceof ResultCodeError && credentialRefusalCodes.has(error.code)) {
        return {kind: "refused"};
      }
      throw error;
    }
    // After a successful bind the password is proven, so a failed read must
    // be the same counted refusal as a wrong password, never an uncounted 503.
    try {
      const {searchEntries} = await client.search(dn, {
        attributes: [
          configuration.emailAttribute,
          configuration.displayNameAttribute,
          "memberOf",
        ],
        filter: "(objectClass=*)",
        scope: "base",
        sizeLimit: 1,
        timeLimit: Math.ceil(configuration.timeoutMilliseconds / 1_000),
      });
      return {entry: searchEntries[0], kind: "read"};
    } catch {
      return {kind: "unreadable"};
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

function tlsOptions(caCertificates: string | null): ConnectionOptions {
  const options: ConnectionOptions = {minVersion: "TLSv1.2"};
  if (caCertificates !== null) options.ca = caCertificates;
  return options;
}

function identityFromEntry(
  configuration: LdapDirectoryConfiguration,
  username: string,
  entry: Entry | undefined,
): Effect.Effect<DirectoryIdentity, DirectorySignInRejected> {
  if (entry === undefined) {
    return Effect.fail(rejected(directoryRejectionReasons.missingEmail));
  }
  const requiredGroup = configuration.requiredGroupDn?.toLowerCase();
  if (
    requiredGroup !== undefined &&
    !attributeValues(entry, "memberOf").some((group) => group.toLowerCase() === requiredGroup)
  ) {
    return Effect.fail(rejected(directoryRejectionReasons.notInRequiredGroup));
  }
  const [firstEmail, ...otherEmails] = attributeValues(entry, configuration.emailAttribute);
  if (firstEmail === undefined) {
    return Effect.fail(rejected(directoryRejectionReasons.missingEmail));
  }
  const [displayName] = attributeValues(entry, configuration.displayNameAttribute);
  return Effect.succeed({
    displayName: displayName === undefined || displayName.length > 200 ? null : displayName,
    emails: [firstEmail, ...otherEmails],
    username: username.trim(),
  });
}

/** Non-empty, trimmed values of one attribute, matched without regard to case. */
function attributeValues(entry: Entry, attribute: string): string[] {
  const wanted = attribute.toLowerCase();
  const key = Object.keys(entry).find((name) => name.toLowerCase() === wanted);
  const raw = key === undefined || key === "dn" ? [] : entry[key];
  return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value).trim())
    .filter((value) => value !== "");
}

function rejected(
  reason: DirectorySignInRejected["reason"],
): DirectorySignInRejected {
  return new DirectorySignInRejected({reason});
}
