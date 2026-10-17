import {spawn} from "node:child_process";
import path from "node:path";

import {Option, type Command} from "commander";
import {currentCliInvocation} from "./current-cli-invocation.js";
import {ensureManagedLocalService} from "./local-service-manager.js";

interface OpenManagementOptions {
  readonly data: string;
}

/** Add the local Artifact Server opener. */
export function configureOpenManagementCommand(
  program: Command,
  defaultDataDirectory: string,
): void {
  program.command("open")
    .description("Open the local Artifact Server application.")
    .addOption(
      new Option("--data <directory>", "persistent data directory")
        .default(defaultDataDirectory),
    )
    .action(async (options: OpenManagementOptions) => {
      const dataDirectory = path.resolve(options.data);
      const origin = (await ensureManagedLocalService(
        dataDirectory,
        currentCliInvocation(),
      )).origin;
      await openSystemBrowser(new URL(origin), process.env);
      process.stdout.write(
        `Opened the local Artifact Server application: ${origin}\n`,
      );
    });
}

/** Open one trusted browser address with the configured operating-system command. */
function openSystemBrowser(
  url: URL,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const configured = environment["ARTIFACT_SERVER_BROWSER_COMMAND"];
  if (configured !== undefined && !path.isAbsolute(configured)) {
    return Promise.reject(new Error(
      "ARTIFACT_SERVER_BROWSER_COMMAND must be an absolute executable path.",
    ));
  }
  const command = configured ?? browserCommand();
  const childArguments = process.platform === "win32" && configured === undefined
    ? ["url.dll,FileProtocolHandler", url.toString()]
    : [url.toString()];
  return new Promise((resolve, reject) => {
    const child = spawn(command, childArguments, {
      detached: configured === undefined,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "/usr/bin/open";
    case "win32":
      return "rundll32.exe";
    default:
      return "xdg-open";
  }
}
