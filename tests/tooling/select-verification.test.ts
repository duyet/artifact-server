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

  test("any source change runs the behavior suite, so no code edit is checked by static tools alone", () => {
    for (const changed of [
      "src/application/artifact-edit.ts",
      "src/mcp/artifact-mcp-server.ts",
      "src/core/ports.ts",
      "integrations/pi/src/index.ts",
    ]) {
      expect(commands([changed])).toContain("pnpm test");
    }
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
      "src/storage/asset-row.ts",
      "src/http/create-http-app.ts",
      "src/application/content-access.ts",
      "src/application/expired-staging-cleanup.ts",
    ]) {
      expect(commands([changed])).toContain("pnpm smoke");
    }
    expect(commands(["src/storage/postgres-artifact-repository.ts"])).not.toContain("pnpm smoke");
  });

  test("web and remote storage changes select their own gates", () => {
    expect(commands(["apps/web/src/home/home-app.tsx"])).toContain("pnpm test:web");
    expect(commands(["src/storage/s3-object-storage.ts"]))
      .toContain("pnpm verify:object-storage");
    expect(commands(["packaging/helm/values.yaml"])).toContain("pnpm verify:helm-static");
  });

  test("browser and integration specs run through the gates that host them", () => {
    expect(commands([
      "tests/browser/frk-009-home-page.spec.ts",
      "tests/integration/external-storage-runtime.test.ts",
      "tests/integration/s3-object-storage.test.ts",
    ])).toEqual([
      ...baseCommands,
      "pnpm test",
      "pnpm test:web",
      "pnpm verify:object-storage",
      "pnpm verify:external-storage-runtime",
    ]);
  });
});
