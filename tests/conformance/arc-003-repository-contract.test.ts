import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, test} from "vitest";

import type {ArtifactPage, ArtifactRecord} from "../../src/core/model.js";
import type {ListArtifacts} from "../../src/core/ports.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {
  artifactRepositoryContract,
  runArtifactRepositoryContractCase,
  type ArtifactRepositoryContractCase,
} from "../support/artifact-repository-contract.js";

type SqliteStore = new (databasePath: string, installationId: string) => SqliteArtifactRepository;

class OldestFirstListing extends SqliteArtifactRepository {
  override async listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    const page = await super.listArtifacts(command);
    return {...page, items: page.items.toReversed()};
  }
}

class DroppedTagRead extends SqliteArtifactRepository {
  override async findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null> {
    const artifact = await super.findArtifact(projectId, artifactId);
    return artifact === null ? null : {...artifact, tags: artifact.tags.slice(0, -1)};
  }
}

async function runCase(
  contractCase: ArtifactRepositoryContractCase,
  Store: SqliteStore = SqliteArtifactRepository,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "arc-003-contract-"));
  try {
    await runArtifactRepositoryContractCase(contractCase, () => {
      const repository = new Store(
        path.join(directory, "artifact-server.sqlite"),
        "arc-003-installation",
      );
      return Promise.resolve({repository, close: () => Promise.resolve(repository.close())});
    });
  } catch (error) {
    throw new Error(`Contract case failed: ${contractCase.name}`, {cause: error});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

function caseNamed(name: string): ArtifactRepositoryContractCase {
  const found = artifactRepositoryContract.find((candidate) => candidate.name.startsWith(name));
  if (found === undefined) throw new Error(`No contract case starts with "${name}".`);
  return found;
}

const divergences = [
  {caught: caseNamed("a listing pages newest first"), Store: OldestFirstListing},
  {caught: caseNamed("access and tag changes"), Store: DroppedTagRead},
];

describe("ARC-003 one repository contract", () => {
  test("ARC-003-B: SQLite passes every case of the shared repository contract that Postgres also runs", async () => {
    expect(artifactRepositoryContract.length).toBeGreaterThanOrEqual(8);
    await Promise.all(artifactRepositoryContract.map((each) => runCase(each)));
  });

  test("ARC-003-F: a store that diverges from the contract fails the case that covers the divergent behavior", async () => {
    const unaffected = caseNamed("a new version moves the current pointer");
    await Promise.all(divergences.map(async ({caught, Store}) => {
      await runCase(caught);
      await expect(runCase(caught, Store)).rejects.toMatchObject({
        cause: {name: "AssertionError"},
        message: `Contract case failed: ${caught.name}`,
      });
      await runCase(unaffected, Store);
    }));
  });
});
