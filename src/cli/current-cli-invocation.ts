import path from "node:path";

/** Executable and fixed arguments required to invoke this exact CLI release. */
export interface CliInvocation {
  readonly command: string;
  readonly prefixArguments: readonly string[];
}

/** Resolve this running CLI without relying on a shell alias or PATH entry. */
export function currentCliInvocation(): CliInvocation {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Artifact Server could not resolve its CLI entrypoint.");
  }
  return {
    command: process.execPath,
    prefixArguments: [...process.execArgv, path.resolve(entrypoint)],
  };
}
