import { createHash, timingSafeEqual } from "node:crypto";

import { Context, Effect, Layer, Redacted } from "effect";

import type { AuthenticatedApplicationSession } from "./authentication.js";
import {
  AuthenticationCache,
  type AuthenticationCachePolicy,
  defaultAuthenticationCachePolicy,
} from "./authentication-cache.js";
import {
  AuthenticationRequired,
  AuthorizationDenied,
  IdentityConflict,
  IdentityNotFound,
  InvalidPagination,
} from "../core/errors.js";
import type {
  IdentityRepositoryFailure,
  LoginAttemptRejected,
} from "../core/errors.js";
import type {
  AdmitMemberRecord,
  CreateApplicationSessionRecord,
  ListInstallationActions,
} from "../core/identity-ports.js";
import {
  unknownOidcUserPolicies,
  type UnknownOidcUserPolicy,
} from "../core/oidc-sign-in.js";
import {
  type ApplicationSession,
  type InstallationMember,
  type IssuedApplicationSession,
  type IssuedManagedApiKey,
  installationActorOf,
  installationOperatorActor,
  installationOperatorPrincipalId,
  type LoginAttempt,
  managedApiKeyCredentialPattern,
  type ManagedApiKey,
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  isDirectHumanPrincipal,
  isHumanAdministrator,
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type MembershipRole,
  type Principal,
  type PrincipalCapability,
} from "../core/identity.js";
import type {
  InstallationActionPage,
  InstallationActor,
  PageCursor,
} from "../core/model.js";

const allCapabilities = Object.values(principalCapabilities);
// A member key creates and republishes its own artifacts and comments; it
// never manages or publishes over other members' work.
const operatorKeyCapabilities = {
  [membershipRoles.administrator]: allCapabilities,
  [membershipRoles.member]: [
    principalCapabilities.createArtifact,
    principalCapabilities.readArtifacts,
    principalCapabilities.writeComments,
    principalCapabilities.issueContentSession,
  ],
} satisfies Record<MembershipRole, readonly PrincipalCapability[]>;
const localBrowserLoginProvider = "artifact-server-local";
const maximumActionPageSize = 100;

export interface InstallationIdentityRepository {
  readonly admitMember: (
    command: AdmitMemberRecord,
  ) => Effect.Effect<InstallationMember, IdentityConflict | IdentityRepositoryFailure>;
  readonly createApiKey: (
    key: StoredManagedApiKey,
    actor: InstallationActor,
  ) => Effect.Effect<ManagedApiKey, IdentityRepositoryFailure>;
  readonly createApplicationSession: (
    command: CreateApplicationSessionRecord,
  ) => Effect.Effect<ApplicationSession, IdentityRepositoryFailure>;
  readonly consumeLoginAttempt: (
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ) => Effect.Effect<
    LoginAttempt,
    LoginAttemptRejected | IdentityRepositoryFailure
  >;
  readonly createLoginAttempt: (
    attempt: LoginAttempt,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly deactivateMember: (
    installationId: string,
    memberId: string,
    updatedAt: string,
    actor: InstallationActor,
  ) => Effect.Effect<
    InstallationMember,
    IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly findActiveMemberByEmail: (
    installationId: string,
    email: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly findMember: (
    installationId: string,
    memberId: string,
  ) => Effect.Effect<InstallationMember | null, IdentityRepositoryFailure>;
  readonly findApiKey: (
    installationId: string,
    keyId: string,
  ) => Effect.Effect<StoredManagedApiKey | null, IdentityRepositoryFailure>;
  readonly findApplicationSession: (
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ) => Effect.Effect<ApplicationSession | null, IdentityRepositoryFailure>;
  readonly hasMembers: (
    installationId: string,
  ) => Effect.Effect<boolean, IdentityRepositoryFailure>;
  readonly listApiKeys: (
    installationId: string,
  ) => Effect.Effect<readonly ManagedApiKey[], IdentityRepositoryFailure>;
  readonly listInstallationActions: (
    command: ListInstallationActions,
  ) => Effect.Effect<InstallationActionPage, IdentityRepositoryFailure>;
  readonly listMembers: (
    installationId: string,
  ) => Effect.Effect<readonly InstallationMember[], IdentityRepositoryFailure>;
  readonly revokeApiKey: (
    installationId: string,
    keyId: string,
    revokedAt: string,
    actor: InstallationActor,
  ) => Effect.Effect<ManagedApiKey, IdentityNotFound | IdentityRepositoryFailure>;
  readonly revokeApplicationSession: (
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly rotateApiKey: (
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
    actor: InstallationActor,
  ) => Effect.Effect<
    ManagedApiKey,
    IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
}

export interface IdentitySecretProvider {
  readonly digest: (value: string) => string;
  readonly issue: () => string;
}

export interface IdentityIdProvider {
  readonly apiKeyId: () => string;
  readonly memberId: () => string;
  readonly sessionId: () => string;
}

export interface InstallationAccessDependencies {
  /**
   * Bounded-staleness cache policy for successful session and managed-key
   * authentication, keyed by installation and credential digest. Omit it to
   * apply {@link defaultAuthenticationCachePolicy}; pass `null` to disable
   * caching. Only successes are cached, entries never outlive the credential's
   * own expiry, and local revocation paths evict, so a credential revoked in
   * another process may authenticate here for at most the TTL.
   */
  readonly authenticationCache?: AuthenticationCachePolicy | null;
  readonly bootstrapAdministratorEmail: string;
  readonly clock: {readonly now: () => Date};
  readonly ids: IdentityIdProvider;
  readonly installationId: string;
  readonly localBootstrapCredential: Redacted.Redacted | null;
  readonly localLoginAttemptLifetimeMilliseconds: number;
  /** Keep the installation's local-owner member permanently active. */
  readonly protectBootstrapAdministrator: boolean;
  readonly repository: InstallationIdentityRepository;
  readonly secrets: IdentitySecretProvider;
  readonly sessionLifetimeMilliseconds: number;
}

export interface AdmitMemberCommand {
  readonly displayName: string;
  readonly email: string;
  readonly principal: Principal;
  readonly role: MembershipRole;
}

/** A human member key minted by an operator with storage access. */
export interface IssueOperatorKeyCommand {
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: string;
  /** Shown as the author of every bearer write made with the key. */
  readonly keyName: string;
  readonly role: MembershipRole;
}

/** The member an operator key belongs to, and its one-time secret. */
export interface IssuedOperatorKey {
  readonly issued: IssuedManagedApiKey;
  readonly member: InstallationMember;
}

/** Input for reading one page of the installation action history. */
export interface ListInstallationActionsCommand {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly principal: Principal;
}

export interface IssueApiKeyCommand {
  readonly capabilities: readonly PrincipalCapability[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
  readonly principal: Principal;
}

/** One short-lived credential intended for a single local browser navigation. */
export interface IssuedLocalBrowserLogin {
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
}

/** What a signed-in principal may read about itself. */
export interface OwnAccount {
  readonly displayName: string;
  /** The member's email; null for a key or service principal. */
  readonly email: string | null;
}

export interface InstallationAccessOperations {
  readonly admitMember: (
    command: AdmitMemberCommand,
  ) => Effect.Effect<
    InstallationMember,
    AuthorizationDenied | IdentityConflict | IdentityRepositoryFailure
  >;
  readonly authenticateManagedApiKey: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationRequired | IdentityRepositoryFailure>;
  readonly authenticateSession: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    AuthenticatedApplicationSession,
    AuthenticationRequired | IdentityRepositoryFailure
  >;
  readonly deactivateMember: (
    principal: Principal,
    memberId: string,
  ) => Effect.Effect<
    InstallationMember,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly issueApiKey: (
    command: IssueApiKeyCommand,
  ) => Effect.Effect<
    IssuedManagedApiKey,
    | AuthorizationDenied
    | IdentityConflict
    | IdentityNotFound
    | IdentityRepositoryFailure
  >;
  readonly listApiKeys: (
    principal: Principal,
  ) => Effect.Effect<readonly ManagedApiKey[], AuthorizationDenied | IdentityRepositoryFailure>;
  /** Project, member, and API-key changes, newest first, for an administrator. */
  readonly listInstallationActions: (
    command: ListInstallationActionsCommand,
  ) => Effect.Effect<
    InstallationActionPage,
    AuthorizationDenied | IdentityRepositoryFailure | InvalidPagination
  >;
  readonly listMembers: (
    principal: Principal,
  ) => Effect.Effect<
    readonly InstallationMember[],
    AuthorizationDenied | IdentityRepositoryFailure
  >;
  /**
   * The principal's own name and email. Only a person's direct session reads
   * an email: a key can carry a member's principal ID, and must not learn it.
   */
  readonly ownAccount: (
    principal: Principal,
  ) => Effect.Effect<OwnAccount, IdentityRepositoryFailure>;
  /**
   * Create or reuse an active member with the requested role by email and
   * mint a key whose browser sign-in acts as that member. Re-issuing the same
   * key name revokes the member's earlier keys with that name. Operators call
   * it with storage access, so no application principal authorizes it.
   */
  readonly issueOperatorKey: (
    command: IssueOperatorKeyCommand,
  ) => Effect.Effect<
    IssuedOperatorKey,
    IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly issueLocalBrowserLogin: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    IssuedLocalBrowserLogin,
    AuthenticationRequired | IdentityRepositoryFailure
  >;
  readonly loginWithLocalBrowserToken: (
    token: Redacted.Redacted,
  ) => Effect.Effect<
    IssuedApplicationSession,
    IdentityConflict | IdentityRepositoryFailure | LoginAttemptRejected
  >;
  /** Issue a session for the stable administrator of a local-owner process. */
  readonly loginAsLocalOwner: () => Effect.Effect<
    IssuedApplicationSession,
    IdentityConflict | IdentityRepositoryFailure
  >;
  /**
   * Issue a member session for an email an identity provider has verified.
   * Only an active member with that email matches. With none, `admit` creates
   * one with role member and `reject` refuses. A deactivated member's email
   * stays refused either way.
   */
  readonly loginWithVerifiedEmail: (
    email: string,
    displayName: string | null,
    unknownUsers: UnknownOidcUserPolicy,
  ) => Effect.Effect<
    IssuedApplicationSession,
    IdentityNotFound | IdentityRepositoryFailure
  >;
  /** Issue a browser session that acts as the presented managed API key. */
  readonly loginWithApiKey: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    IssuedApplicationSession,
    AuthenticationRequired | IdentityRepositoryFailure
  >;
  readonly revokeApiKey: (
    principal: Principal,
    keyId: string,
  ) => Effect.Effect<
    ManagedApiKey,
    AuthorizationDenied | IdentityNotFound | IdentityRepositoryFailure
  >;
  readonly revokeSession: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
  readonly rotateApiKey: (
    principal: Principal,
    keyId: string,
  ) => Effect.Effect<
    IssuedManagedApiKey,
    AuthorizationDenied | IdentityConflict | IdentityNotFound | IdentityRepositoryFailure
  >;
}

/** Installation membership, browser-session, and managed-key lifecycle. */
export class InstallationAccessService extends Context.Service<
  InstallationAccessService,
  InstallationAccessOperations
>()("artifact-server/application/InstallationAccessService") {
  static readonly layer = (
    dependencies: InstallationAccessDependencies,
  ): Layer.Layer<InstallationAccessService> =>
    Layer.succeed(
      InstallationAccessService,
      makeInstallationAccessService(dependencies),
    );
}

function makeInstallationAccessService(
  dependencies: InstallationAccessDependencies,
): InstallationAccessOperations {
  const cachePolicy = dependencies.authenticationCache === undefined
    ? defaultAuthenticationCachePolicy
    : dependencies.authenticationCache;
  const sessionCache = cachePolicy === null
    ? null
    : new AuthenticationCache<AuthenticatedApplicationSession>(cachePolicy);
  const apiKeyCache = cachePolicy === null
    ? null
    : new AuthenticationCache<Principal>(cachePolicy);
  const cacheKey = (digest: string): string =>
    `${dependencies.installationId}:${digest}`;

  const issueSession = Effect.fn(
    "InstallationAccessService.issueSession",
  )(function*(
    subject: CreateApplicationSessionRecord["subject"],
    now: Date,
    expiresAt: Date,
  ) {
    const token = dependencies.secrets.issue();
    const csrfToken = dependencies.secrets.issue();
    const session = yield* dependencies.repository.createApplicationSession({
      createdAt: now.toISOString(),
      csrfDigest: dependencies.secrets.digest(csrfToken),
      expiresAt: expiresAt.toISOString(),
      id: dependencies.ids.sessionId(),
      installationId: dependencies.installationId,
      subject,
      tokenDigest: dependencies.secrets.digest(token),
    });
    return {csrfToken, session, token};
  });

  const issueMemberSession = (member: InstallationMember) => {
    const now = dependencies.clock.now();
    return issueSession(
      {kind: "member", memberId: member.id},
      now,
      new Date(now.getTime() + dependencies.sessionLifetimeMilliseconds),
    );
  };

  const requireLocalBootstrap = Effect.fn(
    "InstallationAccessService.requireLocalBootstrap",
  )(function*(credential: Redacted.Redacted) {
    const configuredCredential = dependencies.localBootstrapCredential;
    if (
      configuredCredential === null ||
      !identitySecretsEqual(
        Redacted.value(credential),
        Redacted.value(configuredCredential),
      )
    ) {
      return yield* Effect.fail(new AuthenticationRequired({
        message: "The local browser-login credential is invalid.",
      }));
    }
    return yield* Effect.void;
  });

  const issueLocalBrowserLogin = Effect.fn(
    "InstallationAccessService.issueLocalBrowserLogin",
  )(function*(credential: Redacted.Redacted) {
    yield* requireLocalBootstrap(credential);
    const now = dependencies.clock.now();
    const expiresAt = new Date(
      now.getTime() + dependencies.localLoginAttemptLifetimeMilliseconds,
    ).toISOString();
    const token = dependencies.secrets.issue();
    yield* dependencies.repository.createLoginAttempt({
      codeVerifier: "not-applicable",
      createdAt: now.toISOString(),
      expiresAt,
      nonce: null,
      provider: localBrowserLoginProvider,
      returnTo: "/",
      stateDigest: dependencies.secrets.digest(token),
    });
    return {
      expiresAt,
      token: Redacted.make(token, {label: "local-browser-login"}),
    };
  });

  const loginAsLocalOwner = Effect.fn(
    "InstallationAccessService.loginAsLocalOwner",
  )(function*() {
    const email = yield* normalizeEmail(dependencies.bootstrapAdministratorEmail);
    let member = yield* dependencies.repository.findActiveMemberByEmail(
      dependencies.installationId,
      email,
    );
    if (member === null) {
      if (yield* dependencies.repository.hasMembers(dependencies.installationId)) {
        return yield* Effect.fail(new IdentityConflict({
          message: "The configured local administrator is not an active member.",
        }));
      }
      member = yield* dependencies.repository.admitMember(selfAdmission({
        createdAt: dependencies.clock.now().toISOString(),
        displayName: "Local administrator",
        email,
        id: dependencies.ids.memberId(),
        installationId: dependencies.installationId,
        role: membershipRoles.administrator,
      }));
    }
    if (member.role !== membershipRoles.administrator) {
      return yield* Effect.fail(new IdentityConflict({
        message: "The configured local administrator is not an administrator.",
      }));
    }
    return yield* issueMemberSession(member);
  });

  const loginWithLocalBrowserToken = Effect.fn(
    "InstallationAccessService.loginWithLocalBrowserToken",
  )(function*(token: Redacted.Redacted) {
    yield* dependencies.repository.consumeLoginAttempt(
      dependencies.secrets.digest(Redacted.value(token)),
      localBrowserLoginProvider,
      dependencies.clock.now().toISOString(),
    );
    return yield* loginAsLocalOwner();
  });

  const authenticateSession = Effect.fn(
    "InstallationAccessService.authenticateSession",
  )(function*(credential: Redacted.Redacted) {
    const now = dependencies.clock.now();
    const tokenDigest = dependencies.secrets.digest(Redacted.value(credential));
    const cached = sessionCache?.get(cacheKey(tokenDigest), now.getTime());
    if (cached !== undefined) return cached;
    const session = yield* dependencies.repository.findApplicationSession(
      dependencies.installationId,
      tokenDigest,
      now.toISOString(),
    );
    if (session === null) {
      return yield* Effect.fail(new AuthenticationRequired({
        message: "A valid application session is required.",
      }));
    }
    const authenticated: AuthenticatedApplicationSession = {
      csrfDigest: session.csrfDigest,
      expiresAt: session.expiresAt,
      principal: yield* sessionPrincipal(session.subject),
    };
    sessionCache?.set(
      cacheKey(tokenDigest),
      authenticated,
      now.getTime(),
      new Date(session.expiresAt).getTime(),
    );
    return authenticated;
  });

  const verifyManagedApiKey = Effect.fn(
    "InstallationAccessService.verifyManagedApiKey",
  )(function*(raw: string, presentedDigest: string, requestTime: Date) {
    const keyId = managedApiKeyCredentialPattern.exec(raw)?.[1];
    if (keyId === undefined) return yield* invalidApiKey();
    const key = yield* dependencies.repository.findApiKey(
      dependencies.installationId,
      keyId,
    );
    if (
      key === null || key.revokedAt !== null ||
      key.expiresAt <= requestTime.toISOString() ||
      !identitySecretsEqual(presentedDigest, key.secretDigest)
    ) {
      return yield* invalidApiKey();
    }
    return key;
  });

  const authenticateManagedApiKey = Effect.fn(
    "InstallationAccessService.authenticateManagedApiKey",
  )(function*(credential: Redacted.Redacted) {
    const raw = Redacted.value(credential);
    const presentedDigest = dependencies.secrets.digest(raw);
    const requestTime = dependencies.clock.now();
    const cached = apiKeyCache?.get(
      cacheKey(presentedDigest),
      requestTime.getTime(),
    );
    if (cached !== undefined) return cached;
    const key = yield* verifyManagedApiKey(raw, presentedDigest, requestTime);
    const principal = apiKeyPrincipal(key);
    apiKeyCache?.set(
      cacheKey(presentedDigest),
      principal,
      requestTime.getTime(),
      new Date(key.expiresAt).getTime(),
    );
    return principal;
  });

  const loginWithApiKey = Effect.fn(
    "InstallationAccessService.loginWithApiKey",
  )(function*(credential: Redacted.Redacted) {
    const raw = Redacted.value(credential);
    const now = dependencies.clock.now();
    const key = yield* verifyManagedApiKey(
      raw,
      dependencies.secrets.digest(raw),
      now,
    );
    const expiresAt = Math.min(
      now.getTime() + dependencies.sessionLifetimeMilliseconds,
      new Date(key.expiresAt).getTime(),
    );
    return yield* issueSession(
      {apiKeyId: key.id, kind: "api_key"},
      now,
      new Date(expiresAt),
    );
  });

  const loginWithVerifiedEmail = Effect.fn(
    "InstallationAccessService.loginWithVerifiedEmail",
  )(function*(
    rawEmail: string,
    displayName: string | null,
    unknownUsers: UnknownOidcUserPolicy,
  ) {
    const noMember = new IdentityNotFound({message: "No active member has this email."});
    // Lowercasing folds some non-ASCII letters onto ASCII ones (U+212A to k),
    // so only an ASCII email may name a member.
    if (!asciiPattern.test(rawEmail)) return yield* noMember;
    const email = yield* normalizeEmail(rawEmail).pipe(Effect.mapError(() => noMember));
    const findMember = () =>
      dependencies.repository.findActiveMemberByEmail(dependencies.installationId, email);
    let member = yield* findMember();
    if (member === null && unknownUsers === unknownOidcUserPolicies.admit) {
      // A deactivated member's email conflicts, and so does a concurrent
      // admission; the second lookup then finds only an active member.
      member = yield* dependencies.repository.admitMember(selfAdmission({
        createdAt: dependencies.clock.now().toISOString(),
        displayName: displayName ?? email,
        email,
        id: dependencies.ids.memberId(),
        installationId: dependencies.installationId,
        role: membershipRoles.member,
      })).pipe(
        Effect.catchTag("IdentityConflict", () => findMember()),
      );
    }
    if (member === null) return yield* noMember;
    return yield* issueMemberSession(member);
  });

  const admitMember = Effect.fn(
    "InstallationAccessService.admitMember",
  )(function*(command: AdmitMemberCommand) {
    yield* requireAdministrator(command.principal, dependencies.installationId);
    const displayName = yield* requireText(command.displayName, "display name");
    const email = yield* normalizeEmail(command.email);
    return yield* dependencies.repository.admitMember({
      actor: installationActorOf(command.principal),
      createdAt: dependencies.clock.now().toISOString(),
      displayName,
      email,
      id: dependencies.ids.memberId(),
      installationId: dependencies.installationId,
      role: command.role,
    });
  });

  const listMembers = Effect.fn(
    "InstallationAccessService.listMembers",
  )(function*(principal: Principal) {
    yield* requireAdministrator(principal, dependencies.installationId);
    return yield* dependencies.repository.listMembers(dependencies.installationId);
  });

  const ownAccount = Effect.fn(
    "InstallationAccessService.ownAccount",
  )(function*(principal: Principal) {
    const member = isDirectHumanPrincipal(principal) &&
        principal.installationId === dependencies.installationId
      ? yield* dependencies.repository.findMember(
        dependencies.installationId,
        principal.id,
      )
      : null;
    return {displayName: principal.displayName, email: member?.email ?? null};
  });

  const deactivateMember = Effect.fn(
    "InstallationAccessService.deactivateMember",
  )(function*(principal: Principal, memberId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    if (principal.id === memberId) {
      return yield* Effect.fail(new IdentityConflict({
        message: "An administrator cannot deactivate their current member.",
      }));
    }
    if (dependencies.protectBootstrapAdministrator) {
      const [member, bootstrapAdministratorEmail] = yield* Effect.all([
        dependencies.repository.findMember(
          dependencies.installationId,
          memberId,
        ),
        normalizeEmail(dependencies.bootstrapAdministratorEmail),
      ]);
      if (member?.email === bootstrapAdministratorEmail) {
        return yield* Effect.fail(new IdentityConflict({
          message: "The local-owner administrator cannot be deactivated.",
        }));
      }
    }
    const member = yield* dependencies.repository.deactivateMember(
      dependencies.installationId,
      memberId,
      dependencies.clock.now().toISOString(),
      installationActorOf(principal),
    );
    // Session entries are keyed by token digest, not member, so this rare
    // administrative mutation clears the whole cache instead of indexing it.
    sessionCache?.clear();
    apiKeyCache?.clear();
    return member;
  });

  const issueApiKey = Effect.fn(
    "InstallationAccessService.issueApiKey",
  )(function*(command: IssueApiKeyCommand) {
    yield* requireAdministrator(command.principal, dependencies.installationId);
    const capabilities = yield* normalizeCapabilities(command.capabilities);
    const expiresAt = yield* requireFutureDate(
      command.expiresAt,
      dependencies.clock.now(),
    );
    const name = yield* requireText(command.name, "API key name");
    const id = dependencies.ids.apiKeyId();
    const secret = dependencies.secrets.issue();
    const token = `as_key_${id}_${secret}`;
    const member = command.memberId === undefined
      ? null
      : yield* dependencies.repository.findMember(
        dependencies.installationId,
        command.memberId,
      );
    if (command.memberId !== undefined && member?.status !== memberStatuses.active) {
      return yield* Effect.fail(new IdentityNotFound({
        message: "The active member for this API key does not exist.",
      }));
    }
    const key: StoredManagedApiKey = {
      authorizedByPrincipalId: command.principal.id,
      capabilities,
      createdAt: dependencies.clock.now().toISOString(),
      expiresAt,
      id,
      installationId: dependencies.installationId,
      name,
      prefix: token.slice(0, Math.min(token.length, 32)),
      principalId: member?.id ?? `service:${id}`,
      principalKind: member === null ? principalKinds.service : principalKinds.human,
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: dependencies.secrets.digest(token),
    };
    const apiKey = yield* dependencies.repository.createApiKey(
      key,
      installationActorOf(command.principal),
    );
    return {apiKey, token};
  });

  const issueOperatorKey = Effect.fn(
    "InstallationAccessService.issueOperatorKey",
  )(function*(command: IssueOperatorKeyCommand) {
    const email = yield* normalizeEmail(command.email);
    const displayName = yield* requireText(command.displayName, "display name");
    const name = yield* requireText(command.keyName, "API key name");
    const now = dependencies.clock.now();
    const expiresAt = yield* requireFutureDate(command.expiresAt, now);
    const existing = yield* dependencies.repository.findActiveMemberByEmail(
      dependencies.installationId,
      email,
    );
    const member = existing ?? (yield* dependencies.repository.admitMember({
      actor: installationOperatorActor,
      createdAt: now.toISOString(),
      displayName,
      email,
      id: dependencies.ids.memberId(),
      installationId: dependencies.installationId,
      role: command.role,
    }));
    if (member.role !== command.role) {
      return yield* Effect.fail(new IdentityConflict({
        message:
          `That email belongs to a member whose role is ${member.role}, not ${command.role}.`,
      }));
    }
    const id = dependencies.ids.apiKeyId();
    const token = `as_key_${id}_${dependencies.secrets.issue()}`;
    const apiKey = yield* dependencies.repository.createApiKey({
      authorizedByPrincipalId: installationOperatorPrincipalId,
      capabilities: operatorKeyCapabilities[command.role],
      createdAt: now.toISOString(),
      expiresAt,
      id,
      installationId: dependencies.installationId,
      name,
      prefix: token.slice(0, Math.min(token.length, 32)),
      principalId: member.id,
      principalKind: principalKinds.human,
      revokedAt: null,
      rotatedFromId: null,
      secretDigest: dependencies.secrets.digest(token),
    }, installationOperatorActor);
    // Revoking after the new key exists means a failed re-issue never leaves
    // a machine without a working key.
    const replaced = (yield* dependencies.repository.listApiKeys(
      dependencies.installationId,
    )).filter((key) =>
      key.id !== apiKey.id && key.principalId === member.id &&
      key.name === name && key.revokedAt === null
    );
    for (const key of replaced) {
      yield* dependencies.repository.revokeApiKey(
        dependencies.installationId,
        key.id,
        now.toISOString(),
        installationOperatorActor,
      );
    }
    if (replaced.length > 0) {
      apiKeyCache?.clear();
      sessionCache?.clear();
    }
    const issued: IssuedOperatorKey = {
      issued: {apiKey, token},
      member,
    };
    return issued;
  });

  // An operator key signs its member in directly, so the session acts as that
  // administrator while the member stays active. Bearer use stays delegated.
  const sessionPrincipal = Effect.fn(
    "InstallationAccessService.sessionPrincipal",
  )(function*(subject: ApplicationSession["subject"]) {
    if (subject.kind === "member") return humanPrincipal(subject.member);
    const key = subject.apiKey;
    if (key.authorizedByPrincipalId !== installationOperatorPrincipalId) {
      return apiKeyPrincipal(key);
    }
    const member = yield* dependencies.repository.findMember(
      dependencies.installationId,
      key.principalId,
    );
    if (member?.status !== memberStatuses.active) {
      return yield* Effect.fail(new AuthenticationRequired({
        message: "A valid application session is required.",
      }));
    }
    return humanPrincipal(member);
  });

  const listApiKeys = Effect.fn(
    "InstallationAccessService.listApiKeys",
  )(function*(principal: Principal) {
    yield* requireAdministrator(principal, dependencies.installationId);
    return yield* dependencies.repository.listApiKeys(dependencies.installationId);
  });

  const listInstallationActions = Effect.fn(
    "InstallationAccessService.listInstallationActions",
  )(function*(command: ListInstallationActionsCommand) {
    yield* requireAdministrator(command.principal, dependencies.installationId);
    if (
      !Number.isSafeInteger(command.limit) || command.limit < 1 ||
      command.limit > maximumActionPageSize
    ) {
      return yield* new InvalidPagination({
        message: `An action page must contain between 1 and ${maximumActionPageSize} records.`,
      });
    }
    return yield* dependencies.repository.listInstallationActions({
      cursor: command.cursor,
      installationId: dependencies.installationId,
      limit: command.limit,
    });
  });

  const revokeApiKey = Effect.fn(
    "InstallationAccessService.revokeApiKey",
  )(function*(principal: Principal, keyId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    const revoked = yield* dependencies.repository.revokeApiKey(
      dependencies.installationId,
      keyId,
      dependencies.clock.now().toISOString(),
      installationActorOf(principal),
    );
    // Key and key-session entries are keyed by credential digest, not key
    // id, so this rare administrative mutation clears both caches.
    apiKeyCache?.clear();
    sessionCache?.clear();
    return revoked;
  });

  const rotateApiKey = Effect.fn(
    "InstallationAccessService.rotateApiKey",
  )(function*(principal: Principal, keyId: string) {
    yield* requireAdministrator(principal, dependencies.installationId);
    const now = dependencies.clock.now();
    const previous = yield* dependencies.repository.findApiKey(
      dependencies.installationId,
      keyId,
    );
    if (previous === null) {
      return yield* Effect.fail(new IdentityNotFound({
        message: "The API key does not exist.",
      }));
    }
    if (previous.revokedAt !== null || previous.expiresAt <= now.toISOString()) {
      return yield* Effect.fail(new IdentityConflict({
        message: "A revoked or expired API key cannot be rotated.",
      }));
    }
    const replacementId = dependencies.ids.apiKeyId();
    const secret = dependencies.secrets.issue();
    const token = `as_key_${replacementId}_${secret}`;
    const replacement: StoredManagedApiKey = {
      ...previous,
      createdAt: now.toISOString(),
      id: replacementId,
      prefix: token.slice(0, Math.min(token.length, 32)),
      revokedAt: null,
      rotatedFromId: previous.id,
      secretDigest: dependencies.secrets.digest(token),
    };
    const apiKey = yield* dependencies.repository.rotateApiKey(
      dependencies.installationId,
      previous.id,
      replacement,
      now.toISOString(),
      installationActorOf(principal),
    );
    apiKeyCache?.clear();
    sessionCache?.clear();
    return {apiKey, token};
  });

  const revokeSession = Effect.fn(
    "InstallationAccessService.revokeSession",
  )(function*(credential: Redacted.Redacted) {
    const tokenDigest = dependencies.secrets.digest(Redacted.value(credential));
    yield* dependencies.repository.revokeApplicationSession(
      dependencies.installationId,
      tokenDigest,
      dependencies.clock.now().toISOString(),
    );
    sessionCache?.evict(cacheKey(tokenDigest));
  });

  return InstallationAccessService.of({
    admitMember,
    authenticateManagedApiKey,
    authenticateSession,
    deactivateMember,
    issueApiKey,
    issueLocalBrowserLogin,
    issueOperatorKey,
    loginAsLocalOwner,
    listApiKeys,
    listInstallationActions,
    listMembers,
    loginWithApiKey,
    loginWithVerifiedEmail,
    loginWithLocalBrowserToken,
    ownAccount,
    revokeApiKey,
    revokeSession,
    rotateApiKey,
  });
}

/** A member admitted by their own sign-in is recorded as admitting themselves. */
function selfAdmission(
  member: Omit<AdmitMemberRecord, "actor">,
): AdmitMemberRecord {
  return {
    ...member,
    actor: {
      authorizedByPrincipalId: null,
      principalDisplayName: member.displayName,
      principalId: member.id,
    },
  };
}

function apiKeyPrincipal(key: ManagedApiKey): Principal {
  return {
    authorizedByPrincipalId: key.authorizedByPrincipalId,
    capabilities: key.capabilities,
    displayName: key.name,
    id: key.principalId,
    installationId: key.installationId,
    kind: key.principalKind,
    membershipRole: membershipRoles.member,
  };
}

function humanPrincipal(member: InstallationMember): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: member.displayName,
    id: member.id,
    installationId: member.installationId,
    kind: principalKinds.human,
    membershipRole: member.role,
  };
}

function requireAdministrator(
  principal: Principal,
  installationId: string,
): Effect.Effect<void, AuthorizationDenied> {
  return principal.installationId === installationId &&
      isHumanAdministrator(principal)
    ? Effect.void
    : Effect.fail(new AuthorizationDenied({
      message: "An Artifact Server administrator is required.",
    }));
}

function invalidApiKey(): Effect.Effect<never, AuthenticationRequired> {
  return Effect.fail(new AuthenticationRequired({
    message: "A valid Artifact Server API key is required.",
  }));
}

const asciiPattern = /^[\x20-\x7E]*$/u;

const normalizeEmail = Effect.fn("InstallationAccessService.normalizeEmail")(
  function*(value: string): Effect.fn.Return<string, IdentityConflict> {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    if (
      normalized.length < 3 || normalized.length > 320 ||
      !normalized.includes("@")
    ) {
      return yield* new IdentityConflict({
        message: "A valid email address is required.",
      });
    }
    return normalized;
  },
);

const requireText = Effect.fn("InstallationAccessService.requireText")(
  function*(value: string, label: string): Effect.fn.Return<string, IdentityConflict> {
    const normalized = value.trim();
    if (normalized.length < 1 || normalized.length > 200) {
      return yield* new IdentityConflict({
        message: `A valid ${label} is required.`,
      });
    }
    return normalized;
  },
);

const requireFutureDate = Effect.fn("InstallationAccessService.requireFutureDate")(
  function*(value: string, now: Date): Effect.fn.Return<string, IdentityConflict> {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      return yield* new IdentityConflict({
        message: "The API key expiration must be a future date and time.",
      });
    }
    return parsed.toISOString();
  },
);

const normalizeCapabilities = Effect.fn(
  "InstallationAccessService.normalizeCapabilities",
)(function*(
  capabilities: readonly PrincipalCapability[],
): Effect.fn.Return<readonly PrincipalCapability[], IdentityConflict> {
  const unique = [...new Set(capabilities)];
  if (
    unique.length === 0 ||
    unique.some((capability) => !allCapabilities.includes(capability))
  ) {
    return yield* new IdentityConflict({
      message: "At least one recognized API key capability is required.",
    });
  }
  return unique.toSorted();
});

/** Constant-time comparison for identity secrets presented by a caller. */
export function identitySecretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes);
}

/** SHA-256 secret digests used by local installation adapters. */
export function digestIdentitySecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
