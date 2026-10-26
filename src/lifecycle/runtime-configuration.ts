import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {access, readFile, stat} from "node:fs/promises";
import path from "node:path";

import {Effect, Option, Redacted, Schema} from "effect";
import {type AssetQuota, defaultAssetQuota} from "../core/asset-policy.js";
import {getDomain} from "tldts";
import {managedApiKeyCredentialPattern} from
  "../core/installation-identity.js";
import {defaultHelpUrl} from "../core/help-link.js";
import {
  type ViewerLogo,
  viewerLogoMaximumBytes,
  viewerLogoMediaTypes,
  type ViewerLogoSource,
} from "../core/viewer-logo.js";
import {
  unknownOidcUserPolicies,
  type UnknownOidcUserPolicy,
} from "../core/oidc-sign-in.js";

import type {
  ObjectStorageProviderFactory,
  ObjectStorageProviderKind,
} from
  "../storage/object-storage-provider.js";
import {
  createS3ObjectStorageProviderFactory,
  type S3ObjectStorageProviderConfig,
} from "../storage/s3-object-storage.js";
import {
  compactInstallationLayout,
  readCompactInstallation,
  type CompactInstallationMetadata,
} from "./compact-installation.js";
import {
  loadStagingCleanupPolicy,
  type StagingCleanupPolicy,
} from "./staging-cleanup.js";

const bearerCredentialSchema = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(200),
  Schema.isPattern(managedApiKeyCredentialPattern),
);
const emailSchema = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  Schema.isMaxLength(320),
);
const hostnameSchema = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u),
);
const installationIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u),
);
const requestLogSampleRateSchema = Schema.NumberFromString.check(
  Schema.isBetween({minimum: 0, maximum: 1}),
);
const postgresUrlSchema = Schema.String.check(
  Schema.isPattern(/^postgres(?:ql)?:\/\/[^\s]+$/u),
);
const urlStringSchema = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s]+$/u),
);
const systemErrorSchema = Schema.Struct({code: Schema.optional(Schema.String)});
const oidcClientIdSchema = Schema.String.check(Schema.isPattern(/^[\x21-\x7E]{1,256}$/u));
const oidcClientSecretSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
);
// Space-separated scope tokens (RFC 6749 section 3.3).
const oidcScopesPattern = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u;

/** Runtime mode selected by one lifecycle command. */
export type DeploymentMode = "compact" | "external-storage";

/** Where a configured credential was loaded without exposing its value. */
export type CredentialSource =
  | "environment"
  | "file"
  | "generated_file"
  | "provider_chain";
type ConfiguredCredentialSource = "environment" | "file";

/** OIDC browser sign-in, present only when `ARTIFACT_SERVER_OIDC_ISSUER` is set. */
export interface OidcSignInConfiguration {
  readonly clientId: string;
  readonly clientSecret: LoadedSecret;
  /** An https URL without a trailing slash. */
  readonly issuer: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly unknownUsers: UnknownOidcUserPolicy;
}

/** What `config check` reports about OIDC sign-in. The secret appears only as its source. */
export interface OidcSignInSummary {
  readonly clientId: string;
  readonly clientSecret: ConfiguredCredentialSource;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly unknownUsers: UnknownOidcUserPolicy;
}

/** Parsed compact configuration used by serving and lifecycle commands. */
export interface CompactRuntimeConfiguration {
  readonly apiToken: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly assetQuota: AssetQuota;
  readonly bootstrapAdministratorEmail: string;
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string | null;
  readonly dataDirectory: string;
  readonly deploymentMode: "compact";
  /** The account menu's Help link. */
  readonly helpUrl: string;
  readonly hostname: string;
  readonly installation: CompactInstallationMetadata;
  readonly logo: ViewerLogo | null;
  readonly oidcSignIn: OidcSignInConfiguration | null;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
  readonly stagingCleanupPolicy: StagingCleanupPolicy;
}

/** Parsed external-storage configuration used by serving and lifecycle commands. */
export interface ExternalStorageRuntimeConfiguration {
  readonly apiToken: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly assetQuota: AssetQuota;
  readonly bootstrapAdministratorEmail: string;
  readonly completedRequestLogSampleRate: number;
  readonly contentDomain: string | null;
  readonly credentialSources: Readonly<Record<
    "apiToken" | "database" | "objectStorageAccessKey" | "objectStorageSecret",
    CredentialSource
  >>;
  readonly databaseUrl: Redacted.Redacted;
  readonly deploymentMode: "external-storage";
  /** The account menu's Help link. */
  readonly helpUrl: string;
  readonly hostname: string;
  readonly installationId: string;
  readonly logo: ViewerLogo | null;
  readonly objectStorage: ObjectStorageProviderFactory;
  readonly oidcSignIn: OidcSignInConfiguration | null;
  readonly port: number;
  readonly postgresMaxConnections: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
  readonly stagingCleanupPolicy: StagingCleanupPolicy;
}

/** Minimum external-storage configuration required by migration commands. */
export interface ExternalMigrationConfiguration {
  readonly databaseCredentialSource: ConfiguredCredentialSource;
  readonly databaseUrl: Redacted.Redacted;
  readonly installationId: string;
}

/** What `config check` reports about the viewer logo. */
export interface ViewerLogoSummary {
  readonly alt: string;
  readonly link: string | null;
  /** The URL or the absolute file path. */
  readonly location: string;
  readonly source: ViewerLogoSource["kind"];
}

/** Public, credential-free summary emitted by `config check`. */
export interface RuntimeConfigurationSummary {
  readonly applicationOrigin: string;
  readonly contentDomain: string | null;
  readonly credentialSources: Readonly<Record<string, CredentialSource>>;
  readonly dataDirectory: string | null;
  readonly deploymentMode: DeploymentMode;
  readonly helpUrl: string;
  readonly hostname: string;
  readonly installationId: string;
  readonly logo: ViewerLogoSummary | null;
  readonly objectStorageProvider: "filesystem" | ObjectStorageProviderKind;
  readonly oidcSignIn: OidcSignInSummary | null;
  readonly port: number;
  readonly readinessWithdrawalMilliseconds: number;
  readonly shutdownDeadlineMilliseconds: number;
  readonly stagingCleanup: StagingCleanupPolicy;
  readonly status: "valid";
}

/** One expected runtime configuration or secret-loading failure. */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "RuntimeConfigurationError",
  {
    field: Schema.String,
    message: Schema.String,
    reason: Schema.Literals([
      "conflicting_secret_sources",
      "incomplete_configuration",
      "invalid_origin",
      "invalid_value",
      "missing_value",
      "path_unavailable",
      "secret_unreadable",
    ]),
  },
) {}

/** Parse only the values required to inspect or migrate Postgres. */
export const parseExternalMigrationConfiguration = Effect.fn(
  "parseExternalMigrationConfiguration",
)(function*(
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ExternalMigrationConfiguration, RuntimeConfigurationError> {
  const databaseUrl = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_DATABASE_URL",
    postgresUrlSchema,
  );
  yield* assertPostgresUrl(Redacted.value(databaseUrl.value));
  return {
    databaseCredentialSource: databaseUrl.source,
    databaseUrl: databaseUrl.value,
    installationId: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_INSTALLATION_ID",
      environment["ARTIFACT_SERVER_INSTALLATION_ID"],
      installationIdSchema,
    ),
  };
});

/** Parse and inspect the compact runtime before it opens a listener. */
export const parseCompactRuntimeConfiguration = Effect.fn(
  "parseCompactRuntimeConfiguration",
)(function*(input: {
  readonly dataDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
  readonly port: string;
}): Effect.fn.Return<CompactRuntimeConfiguration, RuntimeConfigurationError> {
  const installation = yield* readCompactInstallation(input.dataDirectory).pipe(
    Effect.mapError((error) => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: error.message,
      reason: "path_unavailable",
    })),
  );
  const layout = compactInstallationLayout(input.dataDirectory);
  yield* ensureRestoreIsComplete(layout.restoreIncompletePath);
  const apiToken = yield* readGeneratedSecret(
    layout.apiTokenPath,
    "ARTIFACT_SERVER_API_TOKEN",
    bearerCredentialSchema,
  );
  const applicationOrigin = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_ORIGIN",
    input.environment["ARTIFACT_SERVER_ORIGIN"],
    urlStringSchema,
  );
  const contentDomain = yield* parseContentDomain(input.environment);
  yield* assertBrowserIsolation(applicationOrigin, contentDomain);
  yield* ensureWritableDirectory(layout.dataDirectory);
  return {
    apiToken,
    applicationOrigin,
    assetQuota: yield* parseAssetQuota(input.environment),
    bootstrapAdministratorEmail: installation.bootstrapAdministratorEmail,
    completedRequestLogSampleRate: yield* parseSampleRate(input.environment),
    contentDomain,
    dataDirectory: layout.dataDirectory,
    deploymentMode: "compact",
    helpUrl: yield* parseHelpUrl(input.environment),
    hostname: yield* parseHostname(input.hostname),
    installation,
    logo: yield* parseViewerLogo(input.environment),
    oidcSignIn: yield* parseOidcSignIn(input.environment, applicationOrigin),
    port: yield* parsePort(input.port),
    readinessWithdrawalMilliseconds: yield* parseMilliseconds(
      input.environment,
      "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS",
      1_000,
    ),
    shutdownDeadlineMilliseconds: yield* parseMilliseconds(
      input.environment,
      "ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS",
      10_000,
    ),
    stagingCleanupPolicy: yield* parseStagingCleanupPolicy(input.environment),
  };
});

const parseOidcSignIn = Effect.fn("parseOidcSignIn")(function*(
  environment: NodeJS.ProcessEnv,
  applicationOrigin: string,
): Effect.fn.Return<OidcSignInConfiguration | null, RuntimeConfigurationError> {
  const issuer = environment["ARTIFACT_SERVER_OIDC_ISSUER"];
  if (issuer === undefined || issuer === "") return null;
  const scopes = environment["ARTIFACT_SERVER_OIDC_SCOPES"] ?? "";
  if (scopes !== "" && (!oidcScopesPattern.test(scopes) || !scopes.split(" ").includes("openid"))) {
    return yield* invalidValue(
      "ARTIFACT_SERVER_OIDC_SCOPES",
      "ARTIFACT_SERVER_OIDC_SCOPES must be space-separated scopes that include openid.",
    );
  }
  return {
    clientId: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_OIDC_CLIENT_ID",
      environment["ARTIFACT_SERVER_OIDC_CLIENT_ID"],
      oidcClientIdSchema,
    ),
    clientSecret: yield* readSecret(
      environment,
      "ARTIFACT_SERVER_OIDC_CLIENT_SECRET",
      oidcClientSecretSchema,
    ),
    issuer: yield* parseOidcIssuer(issuer),
    redirectUri: new URL("/auth/oidc/callback", applicationOrigin).toString(),
    scopes: scopes === "" ? "openid email profile" : scopes,
    unknownUsers: yield* parseChoice(
      environment,
      "ARTIFACT_SERVER_OIDC_UNKNOWN_USERS",
      [unknownOidcUserPolicies.reject, unknownOidcUserPolicies.admit],
    ),
  };
});

function parseOidcIssuer(value: string): Effect.Effect<string, RuntimeConfigurationError> {
  const field = "ARTIFACT_SERVER_OIDC_ISSUER";
  const refused = invalidValue(
    field,
    `${field} must be an https URL without credentials, query, or fragment.`,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== ""
  ) {
    return refused;
  }
  return Effect.succeed(url.toString().replace(/\/+$/u, ""));
}

/** The first allowed value is the default. */
function parseChoice<const T extends string>(
  environment: NodeJS.ProcessEnv,
  field: string,
  allowed: readonly [T, ...T[]],
): Effect.Effect<T, RuntimeConfigurationError> {
  const value = environment[field];
  if (value === undefined || value === "") return Effect.succeed(allowed[0]);
  const choice = allowed.find((candidate) => candidate === value);
  return choice === undefined
    ? invalidValue(field, `${field} must be one of ${allowed.join(", ")}.`)
    : Effect.succeed(choice);
}

/** Parse external-storage configuration and secret files without connecting. */
export const parseExternalStorageRuntimeConfiguration = Effect.fn(
  "parseExternalStorageRuntimeConfiguration",
)(function*(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly hostname: string;
  readonly port: string;
}): Effect.fn.Return<
  ExternalStorageRuntimeConfiguration,
  RuntimeConfigurationError
> {
  const environment = input.environment;
  const applicationOrigin = yield* parseRequiredEnvironment(
    "ARTIFACT_SERVER_ORIGIN",
    environment["ARTIFACT_SERVER_ORIGIN"],
    urlStringSchema,
  );
  const contentDomain = yield* parseContentDomain(environment);
  yield* assertBrowserIsolation(applicationOrigin, contentDomain);
  const configuredObjectStorage = yield* parseObjectStorage(environment);
  const apiToken = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_API_TOKEN",
    bearerCredentialSchema,
  );
  const databaseUrl = yield* readSecret(
    environment,
    "ARTIFACT_SERVER_DATABASE_URL",
    postgresUrlSchema,
  );
  yield* assertPostgresUrl(Redacted.value(databaseUrl.value));
  return {
    apiToken: apiToken.value,
    applicationOrigin,
    assetQuota: yield* parseAssetQuota(environment),
    bootstrapAdministratorEmail: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL",
      environment["ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL"],
      emailSchema,
    ),
    completedRequestLogSampleRate: yield* parseSampleRate(environment),
    contentDomain,
    credentialSources: {
      apiToken: apiToken.source,
      database: databaseUrl.source,
      objectStorageAccessKey: configuredObjectStorage.accessKeySource,
      objectStorageSecret: configuredObjectStorage.secretSource,
    },
    databaseUrl: databaseUrl.value,
    deploymentMode: "external-storage",
    helpUrl: yield* parseHelpUrl(environment),
    hostname: yield* parseHostname(input.hostname),
    installationId: yield* parseRequiredEnvironment(
      "ARTIFACT_SERVER_INSTALLATION_ID",
      environment["ARTIFACT_SERVER_INSTALLATION_ID"],
      installationIdSchema,
    ),
    logo: yield* parseViewerLogo(environment),
    objectStorage: configuredObjectStorage.factory,
    oidcSignIn: yield* parseOidcSignIn(environment, applicationOrigin),
    port: yield* parsePort(input.port),
    postgresMaxConnections: yield* parsePostgresMaxConnections(environment),
    readinessWithdrawalMilliseconds: yield* parseMilliseconds(
      environment,
      "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS",
      1_000,
    ),
    shutdownDeadlineMilliseconds: yield* parseMilliseconds(
      environment,
      "ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS",
      10_000,
    ),
    stagingCleanupPolicy: yield* parseStagingCleanupPolicy(environment),
  };
});

interface ParsedObjectStorage {
  readonly accessKeySource: CredentialSource;
  readonly factory: ObjectStorageProviderFactory;
  readonly secretSource: CredentialSource;
}

function parseObjectStorage(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ParsedObjectStorage, RuntimeConfigurationError> {
  const provider = environment["ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER"] ?? "s3";
  switch (provider) {
    case "s3":
      return parseS3ObjectStorage(environment);
    default:
      return invalidValue(
        "ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER",
        `The object-storage provider ${provider} is not available in this build.`,
      );
  }
}

const parseS3ObjectStorage = Effect.fn("parseS3ObjectStorage")(
  function*(
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<ParsedObjectStorage, RuntimeConfigurationError> {
    const forcePathStyle = environment["ARTIFACT_SERVER_S3_FORCE_PATH_STYLE"] ??
      "false";
    if (forcePathStyle !== "true" && forcePathStyle !== "false") {
      return yield* invalidValue(
        "ARTIFACT_SERVER_S3_FORCE_PATH_STYLE",
        "The S3 path-style setting must be true or false.",
      );
    }
    const accessKeyId = yield* loadOptionalCredential(
      environment,
      "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
      Schema.NonEmptyString,
    );
    const secretAccessKey = yield* loadOptionalCredential(
      environment,
      "ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY",
      Schema.NonEmptyString,
    );
    if ((accessKeyId === null) !== (secretAccessKey === null)) {
      return yield* new RuntimeConfigurationError({
        field: "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
        message: "The S3 access key ID and secret access key must be configured together.",
        reason: "incomplete_configuration",
      });
    }
    const endpoint = environment["ARTIFACT_SERVER_S3_ENDPOINT"];
    const staticCredentials = accessKeyId === null || secretAccessKey === null
      ? {}
      : {
        accessKeyId: Redacted.value(accessKeyId.value),
        secretAccessKey: secretAccessKey.value,
      };
    const configuredEndpoint = endpoint === undefined
      ? {}
      : {
        endpoint: yield* parseRequiredEnvironment(
          "ARTIFACT_SERVER_S3_ENDPOINT",
          endpoint,
          urlStringSchema,
        ),
      };
    const config: S3ObjectStorageProviderConfig = {
      bucket: yield* parseRequiredEnvironment(
        "ARTIFACT_SERVER_S3_BUCKET",
        environment["ARTIFACT_SERVER_S3_BUCKET"],
        Schema.String.check(Schema.isMinLength(3)),
      ),
      forcePathStyle: forcePathStyle === "true",
      region: yield* parseRequiredEnvironment(
        "ARTIFACT_SERVER_S3_REGION",
        environment["ARTIFACT_SERVER_S3_REGION"],
        Schema.NonEmptyString,
      ),
      ...staticCredentials,
      ...configuredEndpoint,
    };
    if (config.endpoint !== undefined) {
      yield* assertHttpServiceUrl(
        "ARTIFACT_SERVER_S3_ENDPOINT",
        config.endpoint,
      );
    }
    return {
      accessKeySource: accessKeyId?.source ?? "provider_chain",
      factory: createS3ObjectStorageProviderFactory(config),
      secretSource: secretAccessKey?.source ?? "provider_chain",
    };
  },
);

function summarizeOidcSignIn(
  configuration: OidcSignInConfiguration | null,
): OidcSignInSummary | null {
  return configuration === null ? null : {
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret.source,
    issuer: configuration.issuer,
    redirectUri: configuration.redirectUri,
    scopes: configuration.scopes,
    unknownUsers: configuration.unknownUsers,
  };
}

/** Render the safe, stable subset of one parsed runtime configuration. */
export function summarizeRuntimeConfiguration(
  configuration: CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration,
): RuntimeConfigurationSummary {
  if (configuration.deploymentMode === "compact") {
    return {
      applicationOrigin: configuration.applicationOrigin,
      contentDomain: configuration.contentDomain,
      credentialSources: {
        apiToken: "generated_file",
      },
      dataDirectory: configuration.dataDirectory,
      deploymentMode: configuration.deploymentMode,
      helpUrl: configuration.helpUrl,
      hostname: configuration.hostname,
      installationId: configuration.installation.installationId,
      logo: summarizeViewerLogo(configuration.logo),
      objectStorageProvider: "filesystem",
      oidcSignIn: summarizeOidcSignIn(configuration.oidcSignIn),
      port: configuration.port,
      readinessWithdrawalMilliseconds:
        configuration.readinessWithdrawalMilliseconds,
      shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
      stagingCleanup: configuration.stagingCleanupPolicy,
      status: "valid",
    };
  }
  return {
    applicationOrigin: configuration.applicationOrigin,
    contentDomain: configuration.contentDomain,
    credentialSources: {
      ...configuration.credentialSources,
    },
    dataDirectory: null,
    deploymentMode: configuration.deploymentMode,
    helpUrl: configuration.helpUrl,
    hostname: configuration.hostname,
    installationId: configuration.installationId,
    logo: summarizeViewerLogo(configuration.logo),
    objectStorageProvider: configuration.objectStorage.kind,
    oidcSignIn: summarizeOidcSignIn(configuration.oidcSignIn),
    port: configuration.port,
    readinessWithdrawalMilliseconds:
      configuration.readinessWithdrawalMilliseconds,
    shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
    stagingCleanup: configuration.stagingCleanupPolicy,
    status: "valid",
  };
}

function parseStagingCleanupPolicy(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<StagingCleanupPolicy, RuntimeConfigurationError> {
  return loadStagingCleanupPolicy(environment).pipe(
    Effect.mapError((cause) => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_STAGING_CLEANUP",
      message: `The staging cleanup configuration is invalid: ${String(cause)}`,
      reason: "invalid_value",
    })),
  );
}

/** A credential plus its safe configuration-source label. */
export interface LoadedSecret {
  readonly source: ConfiguredCredentialSource;
  readonly value: Redacted.Redacted;
}

function readSecret<T>(
  environment: NodeJS.ProcessEnv,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<LoadedSecret, RuntimeConfigurationError> {
  return loadOptionalCredential(environment, name, schema).pipe(
    Effect.flatMap((value) => value === null
      ? missingValue(name)
      : Effect.succeed(value)),
  );
}

/** Load one optional direct or file-backed credential with conflict checks. */
export function loadOptionalCredential<T>(
  environment: NodeJS.ProcessEnv,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<LoadedSecret | null, RuntimeConfigurationError> {
  const direct = environment[name];
  const fileName = `${name}_FILE`;
  const filePath = environment[fileName];
  if (direct !== undefined && filePath !== undefined) {
    return new RuntimeConfigurationError({
      field: name,
      message: `${name} and ${fileName} cannot both be configured.`,
      reason: "conflicting_secret_sources",
    });
  }
  if (direct === undefined && filePath === undefined) return Effect.succeed(null);
  if (direct !== undefined) {
    return parseRequiredEnvironment(name, direct, schema).pipe(
      Effect.map((value) => ({
        source: "environment" as const,
        value: Redacted.make(String(value), {label: name}),
      })),
    );
  }
  if (filePath === undefined) return Effect.succeed(null);
  return Effect.tryPromise({
    try: () => readFile(path.resolve(filePath), "utf8"),
    catch: () => new RuntimeConfigurationError({
      field: fileName,
      message: `The secret file for ${name} cannot be read.`,
      reason: "secret_unreadable",
    }),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap((value) => parseRequiredEnvironment(name, value, schema)),
    Effect.map((value) => ({
      source: "file" as const,
      value: Redacted.make(String(value), {label: name}),
    })),
  );
}

function readGeneratedSecret<T>(
  filePath: string,
  name: string,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<Redacted.Redacted, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      const metadata = await stat(filePath);
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error("generated secret permissions are too broad");
      }
      return readFile(filePath, "utf8");
    },
    catch: () => new RuntimeConfigurationError({
      field: name,
      message: `The generated secret file for ${name} cannot be read.`,
      reason: "secret_unreadable",
    }),
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.flatMap((value) => parseRequiredEnvironment(name, value, schema)),
    Effect.map((value) => Redacted.make(String(value), {label: name})),
  );
}

function parseRequiredEnvironment<T>(
  field: string,
  value: string | undefined,
  schema: Schema.ConstraintDecoder<T>,
): Effect.Effect<T, RuntimeConfigurationError> {
  if (value === undefined || value === "") {
    return missingValue(field);
  }
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new RuntimeConfigurationError({
      field,
      message: `${field} has an invalid value.`,
      reason: "invalid_value",
    })),
  );
}

function parseContentDomain(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string | null, RuntimeConfigurationError> {
  const value = environment["ARTIFACT_SERVER_CONTENT_DOMAIN"];
  return value === undefined || value === ""
    ? Effect.succeed(null)
    : parseRequiredEnvironment(
      "ARTIFACT_SERVER_CONTENT_DOMAIN",
      value,
      hostnameSchema,
    );
}

function parseSampleRate(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<number, RuntimeConfigurationError> {
  return parseRequiredEnvironment(
    "ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE",
    environment["ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE"] ?? "0.05",
    requestLogSampleRateSchema,
  );
}

function parseMilliseconds(
  environment: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
): Effect.Effect<number, RuntimeConfigurationError> {
  const value = environment[field] ?? String(fallback);
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return invalidValue(
      field,
      `${field} must be a non-negative integer number of milliseconds.`,
    );
  }
  return Effect.succeed(milliseconds);
}

function parseAssetQuota(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<AssetQuota, RuntimeConfigurationError> {
  return Effect.gen(function*() {
    return {
      maximumAssets: yield* parsePositiveInteger(
        environment,
        "ARTIFACT_SERVER_ASSET_QUOTA_COUNT",
        defaultAssetQuota.maximumAssets,
      ),
      maximumBytes: yield* parsePositiveInteger(
        environment,
        "ARTIFACT_SERVER_ASSET_QUOTA_BYTES",
        defaultAssetQuota.maximumBytes,
      ),
    };
  });
}

const viewerLogoAltMaximumLength = 100;
const graphemes = new Intl.Segmenter("en", {granularity: "grapheme"});
// Browsers read `//host` and `/\host` as another host, so a path link starts
// with exactly one slash and holds no backslash, whitespace, or control code.
const rootRelativePathPattern = /^\/(?![/\\])[^\s\\\p{Cc}]*$/u;

/**
 * Parse the optional viewer logo. A file is read once here, so a missing,
 * oversized, or unsupported file stops startup instead of breaking the page.
 */
const parseViewerLogo = Effect.fn("parseViewerLogo")(function*(
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ViewerLogo | null, RuntimeConfigurationError> {
  const location = environment["ARTIFACT_SERVER_LOGO"];
  if (location === undefined || location === "") {
    for (const field of ["ARTIFACT_SERVER_LOGO_ALT", "ARTIFACT_SERVER_LOGO_LINK"]) {
      const value = environment[field];
      if (value !== undefined && value !== "") {
        return yield* new RuntimeConfigurationError({
          field,
          message: `${field} needs ARTIFACT_SERVER_LOGO.`,
          reason: "incomplete_configuration",
        });
      }
    }
    return null;
  }
  const altField = "ARTIFACT_SERVER_LOGO_ALT";
  const alt = environment[altField]?.trim() ?? "";
  if (alt === "") return yield* missingValue(altField);
  if (Array.from(graphemes.segment(alt)).length > viewerLogoAltMaximumLength) {
    return yield* invalidValue(
      altField,
      `${altField} must be at most ${viewerLogoAltMaximumLength} characters.`,
    );
  }
  return {
    alt,
    link: yield* parseViewerLogoLink(environment["ARTIFACT_SERVER_LOGO_LINK"]),
    source: path.isAbsolute(location)
      ? yield* readViewerLogoFile(location)
      : {kind: "url", url: yield* parseHttpsUrl(
        "ARTIFACT_SERVER_LOGO",
        location,
        "ARTIFACT_SERVER_LOGO must be an https:// URL without credentials or an absolute path to an image file.",
      )},
  };
});

const readViewerLogoFile = Effect.fn("readViewerLogoFile")(function*(
  filePath: string,
): Effect.fn.Return<ViewerLogoSource, RuntimeConfigurationError> {
  const field = "ARTIFACT_SERVER_LOGO";
  const extension = path.extname(filePath).toLowerCase();
  const mediaType = Object.entries(viewerLogoMediaTypes)
    .find(([candidate]) => candidate === extension)?.[1];
  if (mediaType === undefined) {
    return yield* invalidValue(
      field,
      `${field} must name a ${Object.keys(viewerLogoMediaTypes).join(", ")} file.`,
    );
  }
  const bytes = yield* Effect.tryPromise({
    catch: () => new RuntimeConfigurationError({
      field,
      message: `${field} is not a readable file.`,
      reason: "path_unavailable",
    }),
    try: async () => {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("not a file");
      // Stat first so an oversized file is refused without reading it.
      return metadata.size > viewerLogoMaximumBytes ? null : readFile(filePath);
    },
  });
  if (bytes === null || bytes.byteLength > viewerLogoMaximumBytes) {
    return yield* invalidValue(
      field,
      `${field} must be at most ${viewerLogoMaximumBytes / 1024} KiB.`,
    );
  }
  return {
    bytes: new Uint8Array(bytes),
    kind: "file",
    mediaType,
    path: filePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

function parseViewerLogoLink(
  value: string | undefined,
): Effect.Effect<string | null, RuntimeConfigurationError> {
  if (value === undefined || value === "") return Effect.succeed(null);
  if (rootRelativePathPattern.test(value)) return Effect.succeed(value);
  return parseHttpsUrl(
    "ARTIFACT_SERVER_LOGO_LINK",
    value,
    "ARTIFACT_SERVER_LOGO_LINK must be an https:// URL without credentials or a path that starts with one /.",
  );
}

function parseHelpUrl(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string, RuntimeConfigurationError> {
  const field = "ARTIFACT_SERVER_HELP_URL";
  const value = environment[field]?.trim() ?? "";
  if (value === "") return Effect.succeed(defaultHelpUrl);
  if (rootRelativePathPattern.test(value)) return Effect.succeed(value);
  return parseHttpsUrl(
    field,
    value,
    `${field} must be an https:// URL without credentials or a path that starts with one /.`,
  );
}

function parseHttpsUrl(
  field: string,
  value: string,
  message: string,
): Effect.Effect<string, RuntimeConfigurationError> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidValue(field, message);
  }
  return url.protocol === "https:" && url.hostname !== "" &&
      url.username === "" && url.password === ""
    ? Effect.succeed(url.href)
    : invalidValue(field, message);
}

function summarizeViewerLogo(logo: ViewerLogo | null): ViewerLogoSummary | null {
  return logo === null ? null : {
    alt: logo.alt,
    link: logo.link,
    location: logo.source.kind === "file" ? logo.source.path : logo.source.url,
    source: logo.source.kind,
  };
}

function parsePositiveInteger(
  environment: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
): Effect.Effect<number, RuntimeConfigurationError> {
  const value = Number(environment[field] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidValue(field, `${field} must be a positive integer.`);
  }
  return Effect.succeed(value);
}

function parsePostgresMaxConnections(
  environment: NodeJS.ProcessEnv,
): Effect.Effect<number, RuntimeConfigurationError> {
  const field = "ARTIFACT_SERVER_POSTGRES_MAX_CONNECTIONS";
  const value = environment[field] ?? "10";
  const maxConnections = Number(value);
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1 || maxConnections > 100
  ) {
    return invalidValue(
      field,
      `${field} must be an integer from 1 through 100.`,
    );
  }
  return Effect.succeed(maxConnections);
}

function parseHostname(
  value: string,
): Effect.Effect<string, RuntimeConfigurationError> {
  if (value === "0.0.0.0" || value === "127.0.0.1" || value === "::1") {
    return Effect.succeed(value);
  }
  return parseRequiredEnvironment("ARTIFACT_SERVER_HOST", value, hostnameSchema);
}

function parsePort(
  value: string,
): Effect.Effect<number, RuntimeConfigurationError> {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return invalidValue(
      "ARTIFACT_SERVER_PORT",
      "The port must be an integer between 0 and 65535.",
    );
  }
  return Effect.succeed(port);
}

function assertPostgresUrl(
  value: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(value);
  } catch {
    return invalidValue(
      "ARTIFACT_SERVER_DATABASE_URL",
      "The database URL must be a valid postgres:// or postgresql:// URL.",
    );
  }
  return databaseUrl.protocol === "postgres:" ||
    databaseUrl.protocol === "postgresql:"
    ? Effect.void
    : invalidValue(
      "ARTIFACT_SERVER_DATABASE_URL",
      "The database URL must use postgres:// or postgresql://.",
    );
}

function assertHttpServiceUrl(
  field: string,
  value: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(value);
  } catch {
    return invalidValue(field, `${field} must be a valid HTTP or HTTPS URL.`);
  }
  if (
    (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") ||
    serviceUrl.username !== "" || serviceUrl.password !== ""
  ) {
    return invalidValue(
      field,
      `${field} must use HTTP or HTTPS and cannot contain credentials.`,
    );
  }
  return Effect.void;
}

function assertBrowserIsolation(
  applicationOrigin: string,
  contentDomain: string | null,
): Effect.Effect<void, RuntimeConfigurationError> {
  let origin: URL;
  try {
    origin = new URL(applicationOrigin);
  } catch {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "The application origin must be an absolute HTTP or HTTPS URL.",
      "invalid_origin",
    );
  }
  if (
    origin.username !== "" || origin.password !== "" ||
    origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
  ) {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "The application origin cannot contain credentials, a path, query, or fragment.",
      "invalid_origin",
    );
  }
  if (origin.protocol !== "https:") {
    return invalidValue(
      "ARTIFACT_SERVER_ORIGIN",
      "Compact and external-storage application origins must use HTTPS.",
      "invalid_origin",
    );
  }
  if (contentDomain === null) return Effect.void;
  const applicationDomain = getDomain(origin.hostname, {allowPrivateDomains: true});
  const publishedDomain = getDomain(contentDomain, {allowPrivateDomains: true});
  if (
    applicationDomain === null || publishedDomain === null ||
    applicationDomain === publishedDomain
  ) {
    return invalidValue(
      "ARTIFACT_SERVER_CONTENT_DOMAIN",
      "The application and published content must use different registrable domains.",
      "invalid_origin",
    );
  }
  return Effect.void;
}

function ensureWritableDirectory(
  dataDirectory: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      const metadata = await stat(dataDirectory);
      if (!metadata.isDirectory()) throw new Error("not a directory");
      await access(dataDirectory, constants.R_OK | constants.W_OK);
    },
    catch: () => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: "The compact data directory is not a writable directory.",
      reason: "path_unavailable",
    }),
  });
}

function ensureRestoreIsComplete(
  markerPath: string,
): Effect.Effect<void, RuntimeConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await access(markerPath, constants.F_OK);
      } catch (error) {
        const parsed = Schema.decodeUnknownOption(systemErrorSchema)(error);
        if (Option.isSome(parsed) && parsed.value.code === "ENOENT") return;
        throw error;
      }
      throw new Error("compact restore is incomplete");
    },
    catch: () => new RuntimeConfigurationError({
      field: "ARTIFACT_SERVER_DATA",
      message: "The compact data directory contains an incomplete restore.",
      reason: "path_unavailable",
    }),
  });
}

function missingValue(
  field: string,
): Effect.Effect<never, RuntimeConfigurationError> {
  return new RuntimeConfigurationError({
    field,
    message: `${field} is required.`,
    reason: "missing_value",
  });
}

function invalidValue(
  field: string,
  message: string,
  reason: "invalid_origin" | "invalid_value" = "invalid_value",
): Effect.Effect<never, RuntimeConfigurationError> {
  return new RuntimeConfigurationError({field, message, reason});
}
