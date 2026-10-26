import {describe, expect, test} from "vitest";

import {selectVerification} from "../../scripts/select-verification.js";

function commands(changedPaths: readonly string[]): readonly string[] {
  return selectVerification(changedPaths).map((step) => step.command);
}

const baseCommands = [
  "pnpm lint",
  "pnpm typecheck",
  "pnpm conformance:validate",
  "pnpm conformance:tests",
];

describe("changed-path verification selection", () => {
  test("a docs-only change still runs the static and ledger checks, and nothing slower", () => {
    expect(commands(["docs/fork/RUNBOOK.md"])).toEqual(baseCommands);
  });

  test("a Postgres or external-storage change cannot skip the Docker-backed runtime suite", () => {
    for (const changed of [
      "src/storage/postgres-artifact-repository.ts",
      "src/external-storage/create-external-storage-runtime.ts",
    ]) {
      expect(commands([changed])).toContain("pnpm verify:external-storage-runtime");
    }
  });

  test("SQLite, HTTP, publication, and cleanup changes run the smoke suite AGENTS.md requires", () => {
    for (const changed of [
      "src/storage/sqlite-artifact-repository.ts",
      "src/http/create-http-app.ts",
      "src/application/staged-upload.ts",
      "src/application/expired-staging-cleanup.ts",
    ]) {
      expect(commands([changed])).toContain("pnpm smoke");
    }
    expect(commands(["src/application/artifact-assets.ts"])).not.toContain("pnpm smoke");
  });

  test("web and remote storage changes select their own gates", () => {
    expect(commands(["apps/web/src/home/home-app.tsx"])).toContain("pnpm test:web");
    expect(commands(["src/storage/s3-object-storage.ts"]))
      .toContain("pnpm verify:object-storage");
    expect(commands(["packaging/helm/values.yaml"])).toContain("pnpm verify:helm-static");
  });

  test("changed unit tests run directly, while browser and integration specs go through their gates", () => {
    expect(commands([
      "tests/conformance/frk-019-asset-store.test.ts",
      "tests/browser/frk-009-home-page.spec.ts",
      "tests/integration/external-storage-runtime.test.ts",
    ])).toEqual([
      ...baseCommands,
      "pnpm exec vitest run tests/conformance/frk-019-asset-store.test.ts",
      "pnpm test:web",
      "pnpm verify:external-storage-runtime",
    ]);
  });
});
