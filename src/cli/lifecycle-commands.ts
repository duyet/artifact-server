import path from "node:path";

import {type Command, Option} from "commander";
import {Redacted} from "effect";

import {
  createExternalStorageRuntime,
  type ExternalStorageRuntimeConfig,
} from "../external-storage/create-external-storage-runtime.js";
import {
  startExternalStorageServer,
} from "../external-storage/start-external-storage-server.js";
import {
  checkCompactIntegrity,
  checkExternalStorageIntegrity,
} from "../lifecycle/integrity-check.js";
import {initializeCompactInstallation} from
  "../lifecycle/compact-installation.js";
import {
  parseCompactRuntimeConfiguration,
  parseExternalMigrationConfiguration,
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
  type CompactRuntimeConfiguration,
  type ExternalStorageRuntimeConfiguration,
  type OidcSignInConfiguration,
} from "../lifecycle/runtime-configuration.js";
import {inspectRuntimeConfiguration} from
  "../lifecycle/runtime-inspection.js";
import {
  createSupportManifest,
  type ProductBuildInformation,
} from "../lifecycle/support-manifest.js";
import {
  createLocalRuntime,
  type LocalRuntimeConfig,
} from "../local/create-local-runtime.js";
import {
  startLocalServer,
} from "../local/start-local-server.js";
import {membershipRoles, type MembershipRole} from "../core/identity.js";
import type {OidcSignIn} from "../core/oidc-sign-in.js";
import {createOidcProvider} from "../identity/oidc-provider.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {runCliEffect} from "./run-cli-effect.js";
import {waitForProcessSignal} from "./wait-for-process-signal.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../core/browser-access.js";

interface StartExternalStorageOptions {
  readonly host: string;
  readonly port: string;
}

interface CompactOptions extends StartExternalStorageOptions {
  readonly data: string;
}

interface LifecycleOptions extends CompactOptions {
  readonly mode: "compact" | "external-storage";
}

interface InitOptions {
  readonly adminEmail: string;
  readonly data: string;
}

interface IssueOperatorKeyOptions extends LifecycleOptions {
  readonly email: string;
  readonly expiresAt?: string;
  readonly keyName?: string;
  readonly name: string;
  readonly role: MembershipRole;
}

const operatorKeyLifetimeMilliseconds = 90 * 24 * 60 * 60 * 1_000;

interface CleanupStagingOptions extends LifecycleOptions {
  readonly limit: string;
  readonly once: boolean;
}

/** Values injected from the release entrypoint into lifecycle commands. */
export interface LifecycleCommandOptions {
  readonly build: ProductBuildInformation;
}

/** Register the complete operator lifecycle surface on one CLI program. */
export function configureLifecycleCommands(
  program: Command,
  options: LifecycleCommandOptions,
): void {
  configureInitialization(program);
  configureCompactStart(program, options.build.productVersion);
  configureConfigurationInspection(program);
  configureMigrations(program);
  configureSupportManifest(program, options.build);
  configureIntegrity(program);
  configureMaintenance(program);
  configureAdministration(program);
  configureExternalStorageStart(program, options.build.productVersion);
}

function configureMaintenance(program: Command): void {
  const maintenance = program
    .command("maintenance")
    .description("Run bounded operator maintenance tasks.");
  maintenance
    .command("cleanup-staging")
    .description("Remove expired uploads that were never committed.")
    .requiredOption("--once", "run one bounded pass and exit")
    .option("--limit <count>", "maximum uploads to examine", "100")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: CleanupStagingOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const runtime = configuration.deploymentMode === "compact"
        ? await createLocalRuntime(compactMaintenanceConfig(configuration))
        : await createExternalStorageRuntime(
          externalMaintenanceConfig(configuration),
        );
      try {
        const report = await runtime.cleanupStaging(
          parseCleanupLimit(options.limit),
        );
        console.log(JSON.stringify(report, null, 2));
        if (report.failed > 0) process.exitCode = 2;
      } finally {
        await runtime.close();
      }
    });
}

function configureAdministration(program: Command): void {
  const admin = program
    .command("admin")
    .description("Issue member keys and recover administrator access with storage access.");
  admin
    .command("issue-key")
    .description(
      "Create or reuse a member and print a new key for them once. Re-issuing a key name replaces that key.",
    )
    .requiredOption("--email <email>", "member email")
    .requiredOption("--name <name>", "member display name")
    .addOption(
      new Option("--role <role>", "member role")
        .choices(Object.values(membershipRoles))
        .default(membershipRoles.administrator),
    )
    .option(
      "--key-name <label>",
      "key name shown as the author of its writes (default: --name)",
    )
    .option(
      "--expires-at <timestamp>",
      "key expiry as an ISO timestamp (default: 90 days from now)",
    )
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: IssueOperatorKeyOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const runtime = configuration.deploymentMode === "compact"
        ? await createLocalRuntime(compactMaintenanceConfig(configuration))
        : await createExternalStorageRuntime(
          externalMaintenanceConfig(configuration),
        );
      try {
        const {issued, member} = await runtime.issueOperatorKey({
          displayName: options.name,
          email: options.email,
          expiresAt: options.expiresAt ?? new Date(
            Date.now() + operatorKeyLifetimeMilliseconds,
          ).toISOString(),
          keyName: options.keyName ?? options.name,
          role: options.role,
        });
        console.log(JSON.stringify({
          apiKey: {
            expiresAt: issued.apiKey.expiresAt,
            id: issued.apiKey.id,
            name: issued.apiKey.name,
          },
          member: {
            displayName: member.displayName,
            email: member.email,
            id: member.id,
            role: member.role,
          },
          token: issued.token,
        }, null, 2));
      } finally {
        await runtime.close();
      }
    });
}

function configureInitialization(program: Command): void {
  program
    .command("init")
    .description("Initialize an empty compact Artifact Server data directory.")
    .requiredOption("--admin-email <email>", "initial administrator email")
    .addOption(dataOption())
    .action(async (options: InitOptions) => {
      const initialized = await runCliEffect(initializeCompactInstallation({
        bootstrapAdministratorEmail: options.adminEmail,
        dataDirectory: options.data,
      }));
      console.log(JSON.stringify({
        dataDirectory: path.resolve(options.data),
        installationId: initialized.installationId,
      }, null, 2));
    });
}

function configureCompactStart(program: Command, productVersion: string): void {
  program
    .command("start-compact")
    .description("Start an initialized compact team server.")
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: CompactOptions) => {
      const configuration = await runCliEffect(
        parseCompactRuntimeConfiguration({
          dataDirectory: options.data,
          environment: process.env,
          hostname: options.host,
          port: options.port,
        }),
      );
      const server = await startCompactServer(configuration, productVersion);
      console.log(JSON.stringify({
        deploymentMode: "compact",
        hostname: server.hostname,
        port: server.port,
        status: "ready",
      }));
      await waitForProcessSignal(() => server.close());
    });
}

function configureConfigurationInspection(program: Command): void {
  const configCommand = program
    .command("config")
    .description("Inspect runtime configuration without serving.");
  configCommand
    .command("check")
    .description("Parse and inspect one exact runtime configuration.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const providers = await inspectRuntimeConfiguration(configuration);
      console.log(JSON.stringify({
        configuration: summarizeRuntimeConfiguration(configuration),
        providers,
      }, null, 2));
      if (providers.status !== "ready") process.exitCode = 2;
    });
}

function configureMigrations(program: Command): void {
  const migrateCommand = program
    .command("migrate")
    .description("Inspect or apply external-storage database migrations.");
  migrateCommand
    .command("status")
    .description("Report schema compatibility without changing Postgres.")
    .action(async () => {
      const configuration = await runCliEffect(
        parseExternalMigrationConfiguration(process.env),
      );
      const database = await PostgresDatabase.inspect({
        applicationName: `artifact-server-migration-status:${configuration.installationId}`,
        maxConnections: 1,
        url: configuration.databaseUrl,
      });
      try {
        console.log(JSON.stringify(await database.migrationStatus(), null, 2));
      } finally {
        await database.close();
      }
    });
  migrateCommand
    .command("apply")
    .description("Apply external-storage migrations under the advisory lock.")
    .action(async () => {
      const configuration = await runCliEffect(
        parseExternalMigrationConfiguration(process.env),
      );
      const database = await PostgresDatabase.open({
        applicationName: `artifact-server-migration-apply:${configuration.installationId}`,
        maxConnections: 1,
        url: configuration.databaseUrl,
      }, "apply");
      try {
        console.log(JSON.stringify(await database.migrationStatus(), null, 2));
      } finally {
        await database.close();
      }
    });
}

function configureSupportManifest(
  program: Command,
  build: ProductBuildInformation,
): void {
  const supportCommand = program
    .command("support")
    .description("Produce credential-free operator diagnostics.");
  supportCommand
    .command("manifest")
    .description("Print product, schema, provider, and configuration versions.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const configuration = await lifecycleConfiguration(options);
      const providers = await inspectRuntimeConfiguration(configuration);
      console.log(JSON.stringify(createSupportManifest(
        build,
        summarizeRuntimeConfiguration(configuration),
        providers,
      ), null, 2));
    });
}

function configureIntegrity(program: Command): void {
  const integrityCommand = program
    .command("integrity")
    .description("Inspect committed records and bytes without repairing them.");
  integrityCommand
    .command("check")
    .description("Verify one compact or external-storage installation.")
    .addOption(modeOption())
    .addOption(dataOption())
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: LifecycleOptions) => {
      const report = options.mode === "compact"
        ? await runCliEffect(checkCompactIntegrity(path.resolve(options.data)))
        : await checkExternalStorageIntegrity(await parseExternalConfiguration(
          options.host,
          options.port,
        ));
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "healthy") process.exitCode = 2;
    });
}

function configureExternalStorageStart(
  program: Command,
  productVersion: string,
): void {
  program
    .command("start-external-storage")
    .description("Start one stateless Postgres and object-storage server process.")
    .addOption(hostOption())
    .addOption(portOption())
    .action(async (options: StartExternalStorageOptions) => {
      const parsed = await parseExternalConfiguration(options.host, options.port);
      const server = await startExternalStorageServer({
        apiToken: parsed.apiToken,
        applicationOrigin: parsed.applicationOrigin,
        assetQuota: parsed.assetQuota,
        bootstrapAdministratorEmail: parsed.bootstrapAdministratorEmail,
        browserAccess: privateTeamBrowserAccess(
          browserLoginKinds.none,
          oidcSignIn(parsed.oidcSignIn),
        ),
        completedRequestLogSampleRate: parsed.completedRequestLogSampleRate,
        contentDomain: parsed.contentDomain,
        databaseUrl: parsed.databaseUrl,
        hostname: parsed.hostname,
        installationId: parsed.installationId,
        objectStorage: parsed.objectStorage,
        port: parsed.port,
        postgresMaxConnections: parsed.postgresMaxConnections,
        readinessWithdrawalMilliseconds: parsed.readinessWithdrawalMilliseconds,
        serviceVersion: productVersion,
        shutdownDeadlineMilliseconds: parsed.shutdownDeadlineMilliseconds,
        stagingCleanupPolicy: parsed.stagingCleanupPolicy,
      });
      const displayHostname = options.host === "0.0.0.0"
        ? "localhost"
        : server.hostname;
      console.log(
        `Artifact Server (external-storage): http://${displayHostname}:${server.port}`,
      );
      await waitForProcessSignal(() => server.close());
    });
}

async function startCompactServer(
  configuration: CompactRuntimeConfiguration,
  productVersion: string,
) {
  return startLocalServer({
    apiToken: Redacted.value(configuration.apiToken),
    applicationOrigin: configuration.applicationOrigin,
    assetQuota: configuration.assetQuota,
    bootstrapAdministratorEmail: configuration.bootstrapAdministratorEmail,
    browserAccess: privateTeamBrowserAccess(
      browserLoginKinds.none,
      oidcSignIn(configuration.oidcSignIn),
    ),
    completedRequestLogSampleRate: configuration.completedRequestLogSampleRate,
    contentDomain: configuration.contentDomain,
    dataDirectory: configuration.dataDirectory,
    hostname: configuration.hostname,
    installationId: configuration.installation.installationId,
    port: configuration.port,
    readinessWithdrawalMilliseconds:
      configuration.readinessWithdrawalMilliseconds,
    serviceVersion: productVersion,
    shutdownDeadlineMilliseconds: configuration.shutdownDeadlineMilliseconds,
    stagingCleanupPolicy: configuration.stagingCleanupPolicy,
  });
}

function oidcSignIn(configuration: OidcSignInConfiguration | null): OidcSignIn | null {
  return configuration === null ? null : {
    provider: createOidcProvider({
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret.value,
      issuer: configuration.issuer,
      redirectUri: configuration.redirectUri,
      scopes: configuration.scopes,
    }),
    unknownUsers: configuration.unknownUsers,
  };
}

async function lifecycleConfiguration(
  options: LifecycleOptions,
): Promise<CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration> {
  return options.mode === "compact"
    ? runCliEffect(parseCompactRuntimeConfiguration({
      dataDirectory: options.data,
      environment: process.env,
      hostname: options.host,
      port: options.port,
    }))
    : parseExternalConfiguration(options.host, options.port);
}

function compactMaintenanceConfig(
  configuration: CompactRuntimeConfiguration,
): LocalRuntimeConfig {
  return {
    apiToken: Redacted.value(configuration.apiToken),
    applicationOrigin: configuration.applicationOrigin,
    bootstrapAdministratorEmail: configuration.bootstrapAdministratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    completedRequestLogSampleRate: 0,
    contentDomain: configuration.contentDomain,
    dataDirectory: configuration.dataDirectory,
    installationId: configuration.installation.installationId,
    observability: true,
    stagingCleanupPolicy: {
      ...configuration.stagingCleanupPolicy,
      schedule: "external",
    },
  };
}

function externalMaintenanceConfig(
  configuration: ExternalStorageRuntimeConfiguration,
): ExternalStorageRuntimeConfig {
  return {
    apiToken: configuration.apiToken,
    applicationOrigin: configuration.applicationOrigin,
    bootstrapAdministratorEmail: configuration.bootstrapAdministratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.none),
    completedRequestLogSampleRate: 0,
    contentDomain: configuration.contentDomain,
    databaseUrl: configuration.databaseUrl,
    installationId: configuration.installationId,
    objectStorage: configuration.objectStorage,
    postgresMaxConnections: configuration.postgresMaxConnections,
    stagingCleanupPolicy: {
      ...configuration.stagingCleanupPolicy,
      schedule: "external",
    },
  };
}

function parseCleanupLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("The cleanup limit must be an integer from 1 through 1000.");
  }
  return limit;
}

function parseExternalConfiguration(
  hostname = process.env["ARTIFACT_SERVER_HOST"] ?? "127.0.0.1",
  port = process.env["ARTIFACT_SERVER_PORT"] ?? "8787",
): Promise<ExternalStorageRuntimeConfiguration> {
  return runCliEffect(parseExternalStorageRuntimeConfiguration({
    environment: process.env,
    hostname,
    port,
  }));
}

function modeOption(): Option {
  return new Option("--mode <mode>", "compact or external-storage")
    .choices(["compact", "external-storage"])
    .default("compact");
}

function dataOption(): Option {
  return new Option("--data <directory>", "compact data directory")
    .default(".artifact-server");
}

function hostOption(): Option {
  return new Option("--host <hostname>", "HTTP bind hostname")
    .default("127.0.0.1")
    .env("ARTIFACT_SERVER_HOST");
}

function portOption(): Option {
  return new Option("--port <number>", "HTTP port")
    .default("8787")
    .env("ARTIFACT_SERVER_PORT");
}
