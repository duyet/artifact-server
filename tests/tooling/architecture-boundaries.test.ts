import {glob, readFile} from "node:fs/promises";
import path from "node:path";

import {describe, expect, test} from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const productCoreDirectories = [
  "src/application/",
  "src/asset-check/",
  "src/comparison/",
  "src/core/",
  "src/manifest/",
] as const;

const productCorePackages: ReadonlySet<string> = new Set([
  "effect",
  "node:crypto",
  "node:path",
  "parse5",
  "unicode-case-folding",
]);

const moduleSpecifierPattern =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gmu;

const deliveryAdapterDirectories = ["src/http/", "src/mcp/"] as const;

const infrastructureDirectories = [
  "src/cli/",
  "src/external-storage/",
  "src/local/",
  "src/storage/",
] as const;

const infrastructurePackages = [
  /^@aws-sdk\//u,
  /^@effect\/sql-pg(?:\/|$)/u,
  /^effect\/unstable\/sql(?:\/|$)/u,
  /^node:sqlite$/u,
  /^pg$/u,
] as const;

describe("architecture boundaries", () => {
  test("ARC-001-F: product core imports no infrastructure, provider, or framework module", async () => {
    const sources = await loadSources(productCoreDirectories);
    expect(sources.size).toBeGreaterThan(0);
    expect([...sources].flatMap(([file, source]) => productCoreViolations(file, source)))
      .toEqual([]);

    expect(productCoreViolations(
      "src/application/publish-artifact.ts",
      [
        'import {DatabaseSync} from "node:sqlite";',
        'import type {SqliteArtifactRepository} from "../storage/sqlite-artifact-repository.js";',
        'import {SqlClient} from "effect/unstable/sql/SqlClient";',
        'export * from "@aws-sdk/client-s3";',
        'const hono = await import("hono");',
        "import {Pool} from \"pg\";",
        'import {startLocalServer} from "../local/start-local-server.js";',
        "import {",
        "  Hono,",
        "  type Context,",
        '} from "hono/tiny";',
        'import "../external-storage/start-external-storage-server.js";',
      ].join("\n"),
    )).toEqual([
      "src/application/publish-artifact.ts: node:sqlite",
      "src/application/publish-artifact.ts: ../storage/sqlite-artifact-repository.js",
      "src/application/publish-artifact.ts: effect/unstable/sql/SqlClient",
      "src/application/publish-artifact.ts: @aws-sdk/client-s3",
      "src/application/publish-artifact.ts: hono",
      "src/application/publish-artifact.ts: pg",
      "src/application/publish-artifact.ts: ../local/start-local-server.js",
      "src/application/publish-artifact.ts: hono/tiny",
      "src/application/publish-artifact.ts: ../external-storage/start-external-storage-server.js",
    ]);
    expect(productCoreViolations(
      "src/core/model.ts",
      [
        "// import {Hono} from \"hono\";",
        'import {Effect} from "effect";',
        'import type {ArtifactRepository} from "./ports.js";',
        'import {createManifest} from "../manifest/create-manifest.js";',
      ].join("\n"),
    )).toEqual([]);
  });

  test("ARC-006-F: no import path from HTTP or MCP reaches storage, composition, or provider modules", async () => {
    const sources = await loadSources(["src/"]);
    const adapterFiles = [...sources.keys()].filter((file) =>
      deliveryAdapterDirectories.some((directory) => file.startsWith(directory))
    );
    expect(adapterFiles.length).toBeGreaterThan(0);
    expect(reachableBypassViolations(sources, adapterFiles)).toEqual([]);

    expect(reachableBypassViolations(new Map([
      ["src/mcp/artifact-mcp-server.ts", [
        'import {SqliteArtifactRepository} from "../storage/sqlite-artifact-repository.js";',
        'import {createLocalRuntime} from "../local/create-local-runtime.js";',
        'import {S3Client} from "@aws-sdk/client-s3";',
        'import {checkIntegrity} from "../lifecycle/integrity-check.js";',
      ].join("\n")],
      ["src/lifecycle/integrity-check.ts", [
        'import {DatabaseSync} from "node:sqlite";',
        'import {SqlClient} from "effect/unstable/sql/SqlClient";',
      ].join("\n")],
    ]), ["src/mcp/artifact-mcp-server.ts"])).toEqual([
      "src/mcp/artifact-mcp-server.ts: ../storage/sqlite-artifact-repository.js",
      "src/mcp/artifact-mcp-server.ts: ../local/create-local-runtime.js",
      "src/mcp/artifact-mcp-server.ts: @aws-sdk/client-s3",
      "src/lifecycle/integrity-check.ts: node:sqlite",
      "src/lifecycle/integrity-check.ts: effect/unstable/sql/SqlClient",
    ]);
    expect(reachableBypassViolations(new Map([
      ["src/http/create-http-app.ts", [
        'import {publishArtifact} from "../application/publish-artifact.js";',
        'import {Hono} from "hono";',
      ].join("\n")],
      ["src/application/publish-artifact.ts", 'import {Effect} from "effect";'],
    ]), ["src/http/create-http-app.ts"])).toEqual([]);
  });
});

async function loadSources(
  directories: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  const patterns = directories.map((directory) => `${directory}**/*.ts`);
  for await (const relativePath of glob(patterns, {cwd: repositoryRoot})) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    sources.set(relativePath.split(path.sep).join("/"), source);
  }
  return sources;
}

function reachableBypassViolations(
  sources: ReadonlyMap<string, string>,
  entries: readonly string[],
): readonly string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [...entries];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    const source = sources.get(file);
    if (!visited.has(file) && source !== undefined) {
      visited.add(file);
      violations.push(...adapterBypassViolations(file, source));
      pending.push(...relativeImports(file, source));
    }
  }
  return violations;
}

function productCoreViolations(relativePath: string, source: string): readonly string[] {
  return violatingSpecifiers(relativePath, source, (specifier, target) =>
    target === null
      ? !productCorePackages.has(specifier)
      : !productCoreDirectories.some((directory) => target.startsWith(directory))
  );
}

function adapterBypassViolations(relativePath: string, source: string): readonly string[] {
  return violatingSpecifiers(relativePath, source, (specifier, target) =>
    target === null
      ? infrastructurePackages.some((pattern) => pattern.test(specifier))
      : infrastructureDirectories.some((directory) => target.startsWith(directory))
  );
}

function relativeImports(relativePath: string, source: string): readonly string[] {
  return moduleSpecifiers(source).flatMap((specifier) => {
    const target = relativeTarget(relativePath, specifier);
    return target === null ? [] : [target.replace(/\.js$/u, ".ts")];
  });
}

function moduleSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(moduleSpecifierPattern)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function violatingSpecifiers(
  relativePath: string,
  source: string,
  isViolation: (specifier: string, relativeTarget: string | null) => boolean,
): readonly string[] {
  return moduleSpecifiers(source)
    .filter((specifier) => isViolation(specifier, relativeTarget(relativePath, specifier)))
    .map((specifier) => `${relativePath}: ${specifier}`);
}

function relativeTarget(relativePath: string, specifier: string): string | null {
  return specifier.startsWith(".")
    ? path.posix.join(path.posix.dirname(relativePath), specifier)
    : null;
}
