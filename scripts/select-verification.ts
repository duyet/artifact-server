import {execFileSync, spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";

/** One verification command and why the changed paths need it. */
export interface VerificationStep {
  readonly command: string;
  readonly reason: string;
}

interface GateRule {
  readonly command: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const baseSteps: readonly VerificationStep[] = [
  {command: "pnpm lint", reason: "every change"},
  {command: "pnpm typecheck", reason: "every change"},
  {command: "pnpm conformance:validate", reason: "every change"},
  {command: "pnpm conformance:tests", reason: "every change"},
];

// The same areas AGENTS.md names under "Performance verification".
const gateRules: readonly GateRule[] = [
  {
    command: "pnpm smoke",
    pattern:
      /^src\/(?:http|lifecycle|local)\/|^src\/storage\/(?:sqlite-|local-)|^src\/application\/(?:publish|staged-upload|expired-staging)/u,
    reason: "HTTP delivery, publication, SQLite, blob storage, restart, or cleanup",
  },
  {
    command: "pnpm test:web",
    pattern: /^apps\/web\/|^tests\/browser\//u,
    reason: "web UI or browser specs",
  },
  {
    command: "pnpm verify:object-storage",
    pattern: /^src\/storage\/(?:s3-|cloud-object-storage|object-storage-provider)/u,
    reason: "remote blob or staging storage (needs Docker)",
  },
  {
    command: "pnpm verify:external-storage-runtime",
    pattern: /^src\/storage\/postgres-|^src\/external-storage\/|^tests\/integration\/external-storage-runtime/u,
    reason: "Postgres persistence or external-storage composition (needs Docker)",
  },
  {
    command: "pnpm verify:helm-static",
    pattern: /^packaging\/helm\//u,
    reason: "Helm chart",
  },
  {
    command: "pnpm verify:oci-image",
    pattern: /^packaging\/oci\//u,
    reason: "OCI image (needs Docker)",
  },
];

const unitTestPattern = /^tests\/(?!browser\/|integration\/|pi-live\/|release\/).+\.test\.ts$/u;

/** The ordered verification steps the changed repository paths call for. */
export function selectVerification(
  changedPaths: readonly string[],
): readonly VerificationStep[] {
  const changedTests = changedPaths.filter((changed) => unitTestPattern.test(changed));
  const testSteps = changedTests.length === 0
    ? []
    : [{
      command: `pnpm exec vitest run ${changedTests.toSorted().join(" ")}`,
      reason: "changed unit and conformance tests",
    }];
  const gateSteps = gateRules
    .filter((rule) => changedPaths.some((changed) => rule.pattern.test(changed)))
    .map(({command, reason}) => ({command, reason}));
  return [...baseSteps, ...testSteps, ...gateSteps];
}

function git(...args: string[]): readonly string[] {
  return execFileSync("git", args, {encoding: "utf8"}).split("\n").filter(Boolean);
}

function changedSince(base: string): readonly string[] {
  const [mergeBase] = git("merge-base", base, "HEAD");
  if (mergeBase === undefined) throw new Error(`No merge base with ${base}.`);
  return [
    ...new Set([
      ...git("diff", "--name-only", mergeBase),
      ...git("ls-files", "--others", "--exclude-standard"),
    ]),
  ];
}

function main(): void {
  const run = process.argv.includes("--run");
  const base = process.argv.slice(2).find((argument) => !argument.startsWith("-")) ??
    "origin/main";
  const steps = selectVerification(changedSince(base));
  for (const step of steps) {
    console.log(`${step.command}  # ${step.reason}`);
  }
  if (!run) return;
  for (const step of steps) {
    console.log(`\n> ${step.command}`);
    const result = spawnSync(step.command, {shell: true, stdio: "inherit"});
    if (result.status !== 0) {
      console.error(`Failed: ${step.command}`);
      process.exit(result.status ?? 1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
