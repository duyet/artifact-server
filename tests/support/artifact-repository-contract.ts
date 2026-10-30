import {createHash} from "node:crypto";

import {expect, test} from "vitest";

import {defaultAssetQuota} from "../../src/core/asset-policy.js";
import {defaultProjectId, type PublishedVersion} from "../../src/core/model.js";
import type {
  ArtifactAssetRepository,
  ArtifactRepository,
  CommitArtifactVersion,
  CommitNewArtifact,
  ListArtifacts,
  PublicationSource,
  StagedUploadRepository,
} from "../../src/core/ports.js";
import {SystemIdGenerator} from "../../src/core/system.js";
import {createManifest} from "../../src/manifest/create-manifest.js";

/** The repository surface every supported database must serve identically. */
export type ContractRepository =
  ArtifactRepository & ArtifactAssetRepository & StagedUploadRepository;

export interface OpenedContractRepository {
  readonly repository: ContractRepository;
  close(): Promise<void>;
}

export interface ArtifactRepositoryContractCase {
  readonly name: string;
  check(repository: ContractRepository): Promise<void>;
}

const ids = new SystemIdGenerator();
const projectId = defaultProjectId;
const publisher = {displayName: "Contract Publisher", principalId: "contract-publisher"};
const uploadExpiry = "2126-01-01T00:00:00.000Z";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
}

async function stageContent(
  repository: ContractRepository,
  content: string,
  createdAt: string,
  extraPaths: readonly string[] = [],
): Promise<{readonly manifest: CommitNewArtifact["manifest"]; readonly source: PublicationSource}> {
  const bytes = new TextEncoder().encode(content);
  const manifest = createManifest({
    entryPath: "index.html",
    files: ["index.html", ...extraPaths].map((filePath) => ({
      mediaType: "text/html; charset=utf-8",
      path: filePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    })),
    routingMode: "static",
  });
  const uploadId = ids.uploadId();
  const files = manifest.entries.map((entry) => ({entry, storageToken: ids.stagedFileToken()}));
  await repository.createStagedUpload({
    createdAt,
    expiresAt: uploadExpiry,
    files,
    id: uploadId,
    manifest,
    principalId: publisher.principalId,
    projectId,
  });
  await Promise.all(files.map((file) => repository.markStagedFileUploaded(
    projectId,
    uploadId,
    publisher.principalId,
    file.storageToken,
    createdAt,
  )));
  return {
    manifest,
    source: {kind: "staged_upload", principalId: publisher.principalId, projectId, uploadId},
  };
}

async function newArtifactCommand(
  repository: ContractRepository,
  input: {
    readonly createdAt: string;
    /** Files beside `index.html`, all holding the same page. */
    readonly extraPaths?: readonly string[];
    readonly idempotencyKey: string;
    readonly name: string;
    readonly path?: string;
    readonly tags?: readonly string[];
  },
): Promise<CommitNewArtifact> {
  const staged = await stageContent(
    repository,
    `<h1>${input.name}</h1>`,
    input.createdAt,
    input.extraPaths,
  );
  return {
    accessSetting: "account_required",
    artifactId: ids.artifactId(),
    authorizedByPrincipalId: null,
    contentToken: ids.contentToken(),
    createdAt: input.createdAt,
    idempotencyKey: input.idempotencyKey,
    inputDigest: `${input.idempotencyKey}-input`,
    manifest: staged.manifest,
    name: input.name,
    path: input.path ?? null,
    principalDisplayName: publisher.displayName,
    principalId: publisher.principalId,
    projectId,
    source: staged.source,
    tags: input.tags ?? [],
    versionId: ids.versionId(),
  };
}

async function publishArtifact(
  repository: ContractRepository,
  input: Parameters<typeof newArtifactCommand>[1],
): Promise<PublishedVersion> {
  return repository.commitNewArtifact(await newArtifactCommand(repository, input));
}

async function versionCommand(
  repository: ContractRepository,
  published: PublishedVersion,
  input: {
    readonly content: string;
    readonly createdAt: string;
    readonly extraPaths?: readonly string[];
    readonly idempotencyKey: string;
  },
): Promise<CommitArtifactVersion> {
  const staged = await stageContent(repository, input.content, input.createdAt, input.extraPaths);
  return {
    artifactId: published.artifact.id,
    authorizedByPrincipalId: null,
    contentToken: ids.contentToken(),
    createdAt: input.createdAt,
    edit: null,
    expectedCurrentVersionId: published.version.id,
    idempotencyKey: input.idempotencyKey,
    inputDigest: `${input.idempotencyKey}-input`,
    manifest: staged.manifest,
    principalDisplayName: publisher.displayName,
    principalId: publisher.principalId,
    projectId,
    source: staged.source,
    versionId: ids.versionId(),
  };
}

function management(published: PublishedVersion, idempotencyKey: string, createdAt: string) {
  return {
    artifactId: published.artifact.id,
    authorizedByPrincipalId: null,
    createdAt,
    expectedCurrentVersionId: published.version.id,
    idempotencyKey,
    inputDigest: `${idempotencyKey}-input`,
    principalId: publisher.principalId,
    projectId,
  };
}

function listing(overrides: Partial<ListArtifacts> = {}): ListArtifacts {
  return {
    comments: "all",
    cursor: null,
    limit: 50,
    owner: {kind: "any"},
    projectId,
    sort: "newest",
    tags: [],
    ...overrides,
  };
}

async function listedIds(
  repository: ContractRepository,
  overrides: Partial<ListArtifacts> = {},
): Promise<readonly string[]> {
  const page = await repository.listArtifacts(listing(overrides));
  return page.items.map((item) => item.id);
}

export const artifactRepositoryContract: readonly ArtifactRepositoryContractCase[] = [
  {
    name: "a new artifact and its first version read back exactly as committed",
    async check(repository) {
      const command = await newArtifactCommand(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-create",
        name: "Quarterly Report",
        path: "reports/quarterly",
        tags: ["finance"],
      });
      const published = await repository.commitNewArtifact(command);
      expect(published.replayed).toBe(false);
      expect(published.artifact).toEqual({
        accessSetting: "account_required",
        createdAt: command.createdAt,
        currentVersionId: command.versionId,
        deletedAt: null,
        id: command.artifactId,
        name: "Quarterly Report",
        owner: {displayName: publisher.displayName, principalId: publisher.principalId},
        path: "reports/quarterly",
        projectId,
        tags: ["finance"],
      });
      expect(published.version).toMatchObject({
        artifactId: command.artifactId,
        contentToken: command.contentToken,
        createdAt: command.createdAt,
        entryPath: "index.html",
        id: command.versionId,
        manifestDigest: command.manifest.digest,
        number: 1,
        publisherDisplayName: publisher.displayName,
        publisherPrincipalId: publisher.principalId,
        routingMode: "static",
      });
      await expect(repository.findArtifact(projectId, command.artifactId))
        .resolves.toEqual(published.artifact);
      await expect(repository.findCurrentVersion(projectId, command.artifactId))
        .resolves.toEqual(published);
      const saved = await repository.findVersionRecord(
        projectId,
        command.artifactId,
        command.versionId,
      );
      expect(saved?.manifest.digest).toBe(command.manifest.digest);
      expect(saved?.manifest.entries).toEqual(command.manifest.entries);
      await expect(repository.findArtifactByPath(["reports/quarterly"]))
        .resolves.toEqual({id: command.artifactId, path: "reports/quarterly"});
    },
  },
  {
    name: "a new version moves the current pointer and leaves the first version unchanged",
    async check(repository) {
      const first = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-first",
        name: "Changelog",
      });
      const firstSaved = await repository.findVersionRecord(
        projectId,
        first.artifact.id,
        first.version.id,
      );
      const command = await versionCommand(repository, first, {
        content: "<h1>Changelog, second edition</h1>",
        createdAt: at(1),
        idempotencyKey: "contract-second",
      });
      const second = await repository.commitVersion(command);
      expect(second.version).toMatchObject({
        id: command.versionId,
        manifestDigest: command.manifest.digest,
        number: 2,
      });
      expect(second.artifact.currentVersionId).toBe(command.versionId);
      await expect(repository.findArtifact(projectId, first.artifact.id))
        .resolves.toMatchObject({currentVersionId: command.versionId});
      await expect(repository.findVersionRecord(projectId, first.artifact.id, first.version.id))
        .resolves.toEqual(firstSaved);
      const versions = await repository.listArtifactVersions(projectId, first.artifact.id);
      expect(versions.map((version) => [version.id, version.number])).toEqual([
        [command.versionId, 2],
        [first.version.id, 1],
      ]);
    },
  },
  {
    name: "replaying a publish key returns the first result and a changed input under it is refused",
    async check(repository) {
      const command = await newArtifactCommand(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-replay",
        name: "Replayed",
      });
      const first = await repository.commitNewArtifact(command);
      const replay = await repository.commitNewArtifact(command);
      expect(replay.replayed).toBe(true);
      expect(replay.artifact.id).toBe(first.artifact.id);
      expect(replay.version.id).toBe(first.version.id);
      const changed = await newArtifactCommand(repository, {
        createdAt: at(1),
        idempotencyKey: "contract-replay",
        name: "Changed under the same key",
      });
      await expect(repository.commitNewArtifact({...changed, inputDigest: "contract-changed-input"}))
        .rejects.toMatchObject({_tag: "IdempotencyConflict"});
      await expect(listedIds(repository)).resolves.toEqual([first.artifact.id]);
    },
  },
  {
    name: "a stale expected version is refused and changes nothing",
    async check(repository) {
      const first = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-stale-base",
        name: "Stale Base",
      });
      const second = await repository.commitVersion(await versionCommand(repository, first, {
        content: "<h1>moved on</h1>",
        createdAt: at(1),
        idempotencyKey: "contract-stale-move",
      }));
      await expect(repository.commitVersion(await versionCommand(repository, first, {
        content: "<h1>stale publish</h1>",
        createdAt: at(2),
        idempotencyKey: "contract-stale-publish",
      }))).rejects.toMatchObject({_tag: "PublishConflict"});
      await expect(repository.renameArtifact({
        ...management(first, "contract-stale-rename", at(3)),
        name: "Stale Rename",
      })).rejects.toMatchObject({_tag: "ArtifactMutationConflict"});
      await expect(repository.changeTags({
        ...management(first, "contract-stale-tags", at(3)),
        tags: ["stale"],
      })).rejects.toMatchObject({_tag: "ArtifactMutationConflict"});
      await expect(repository.deleteArtifact(management(first, "contract-stale-delete", at(3))))
        .rejects.toMatchObject({_tag: "ArtifactMutationConflict"});
      await expect(repository.findArtifact(projectId, first.artifact.id))
        .resolves.toEqual(second.artifact);
      const versions = await repository.listArtifactVersions(projectId, first.artifact.id);
      expect(versions.map((version) => version.id)).toEqual([second.version.id, first.version.id]);
    },
  },
  {
    name: "a rename changes what search finds and replays under its key",
    async check(repository) {
      const published = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-rename-base",
        name: "Draft Notes",
      });
      const rename = {...management(published, "contract-rename", at(1)), name: "Launch Plan"};
      const renamed = await repository.renameArtifact(rename);
      expect(renamed.artifact.name).toBe("Launch Plan");
      expect(renamed.replayed).toBe(false);
      await expect(repository.renameArtifact(rename)).resolves.toMatchObject({
        artifact: {name: "Launch Plan"},
        replayed: true,
      });
      await expect(repository.findArtifact(projectId, published.artifact.id))
        .resolves.toMatchObject({name: "Launch Plan"});
      await expect(listedIds(repository, {search: "launch"}))
        .resolves.toEqual([published.artifact.id]);
      await expect(listedIds(repository, {search: "draft"})).resolves.toEqual([]);
    },
  },
  {
    name: "access and tag changes replace the stored values that reads and filters see",
    async check(repository) {
      const published = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-settings-base",
        name: "Settings",
        tags: ["old"],
      });
      const opened = await repository.changeAccessSetting({
        ...management(published, "contract-access", at(1)),
        accessSetting: "public_link",
      });
      expect(opened.artifact.accessSetting).toBe("public_link");
      // Callers pass tags in code-point order, where a hyphen sorts before
      // every letter; a store must read them back in that same order.
      const tagged = await repository.changeTags({
        ...management(published, "contract-tags", at(2)),
        tags: ["alpha", "design-review", "designer"],
      });
      expect(tagged.artifact.tags).toEqual(["alpha", "design-review", "designer"]);
      await expect(repository.findArtifact(projectId, published.artifact.id))
        .resolves.toMatchObject({
          accessSetting: "public_link",
          tags: ["alpha", "design-review", "designer"],
        });
      await expect(listedIds(repository, {tags: ["design-review"]}))
        .resolves.toEqual([published.artifact.id]);
      await expect(listedIds(repository, {tags: ["old"]})).resolves.toEqual([]);
    },
  },
  {
    name: "a folder path holds its own artifact, the longest path routes, and a hidden file is refused",
    async check(repository) {
      const child = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-nest-child",
        name: "Runbook",
        path: "docs/team/runbook",
      });
      const folder = await publishArtifact(repository, {
        createdAt: at(1),
        idempotencyKey: "contract-nest-folder",
        name: "Team",
        path: "docs/team",
      });
      await expect(publishArtifact(repository, {
        createdAt: at(2),
        idempotencyKey: "contract-nest-equal",
        name: "Team Again",
        path: "docs/team",
      })).rejects.toMatchObject({
        _tag: "ArtifactPathTaken",
        message: 'The path "docs/team" already belongs to another artifact.',
      });
      // Candidates arrive in any order; the deepest live path wins.
      await expect(repository.findArtifactByPath(["docs", "docs/team", "docs/team/runbook"]))
        .resolves.toEqual({id: child.artifact.id, path: "docs/team/runbook"});
      await expect(repository.findArtifactByPath(["docs/team/notes", "docs/team", "docs"]))
        .resolves.toEqual({id: folder.artifact.id, path: "docs/team"});

      // A new folder version may not carry a file the child hides.
      await expect(repository.commitVersion(await versionCommand(repository, folder, {
        content: "<h1>Team v2</h1>",
        createdAt: at(3),
        extraPaths: ["runbook/index.html"],
        idempotencyKey: "contract-nest-hidden-version",
      }))).rejects.toMatchObject({
        _tag: "ArtifactPathTaken",
        message: 'The file "runbook/index.html" in the artifact path "docs/team" would be hidden by the artifact path "docs/team/runbook".',
      });
      await expect(repository.commitVersion(await versionCommand(repository, folder, {
        content: "<h1>Team v2</h1>",
        createdAt: at(4),
        extraPaths: ["runbook-old/index.html"],
        idempotencyKey: "contract-nest-sibling-version",
      }))).resolves.toMatchObject({version: {number: 2}});

      // A new folder artifact may not carry a file an existing child hides.
      await publishArtifact(repository, {
        createdAt: at(5),
        idempotencyKey: "contract-nest-guide-page",
        name: "Setup",
        path: "guides/setup",
      });
      await expect(publishArtifact(repository, {
        createdAt: at(6),
        extraPaths: ["setup"],
        idempotencyKey: "contract-nest-hidden-folder",
        name: "Guides",
        path: "guides",
      })).rejects.toMatchObject({
        _tag: "ArtifactPathTaken",
        message: 'The file "setup" in the artifact path "guides" would be hidden by the artifact path "guides/setup".',
      });

      // A new child may not hide a file the folder already serves.
      await publishArtifact(repository, {
        createdAt: at(7),
        extraPaths: ["intro/index.html"],
        idempotencyKey: "contract-nest-handbook",
        name: "Handbook",
        path: "handbook",
      });
      await expect(publishArtifact(repository, {
        createdAt: at(8),
        idempotencyKey: "contract-nest-hiding-child",
        name: "Intro",
        path: "handbook/intro",
      })).rejects.toMatchObject({
        _tag: "ArtifactPathTaken",
        message: 'The file "intro/index.html" in the artifact path "handbook" would be hidden by the artifact path "handbook/intro".',
      });
      await expect(publishArtifact(repository, {
        createdAt: at(9),
        idempotencyKey: "contract-nest-sibling-child",
        name: "Introduction",
        path: "handbook/introduction",
      })).resolves.toMatchObject({artifact: {path: "handbook/introduction"}});
    },
  },
  {
    name: "a deleted artifact leaves every live read and frees its path",
    async check(repository) {
      const published = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-delete-base",
        name: "Retired",
        path: "retired/page",
      });
      await expect(publishArtifact(repository, {
        createdAt: at(1),
        idempotencyKey: "contract-delete-taken",
        name: "Too Early",
        path: "retired/page",
      })).rejects.toMatchObject({_tag: "ArtifactPathTaken"});
      const deletion = await repository.deleteArtifact(
        management(published, "contract-delete", at(2)),
      );
      expect(deletion).toMatchObject({
        artifact: {deletedAt: at(2), id: published.artifact.id},
        replayed: false,
        retainedVersionCount: 1,
      });
      await expect(repository.findArtifact(projectId, published.artifact.id)).resolves.toBeNull();
      await expect(repository.findCurrentVersion(projectId, published.artifact.id))
        .resolves.toBeNull();
      await expect(repository.findArtifactByPath(["retired/page"])).resolves.toBeNull();
      await expect(repository.findArtifactForAdministration(projectId, published.artifact.id))
        .resolves.toMatchObject({deletedAt: at(2)});
      await expect(listedIds(repository)).resolves.toEqual([]);
      const successor = await publishArtifact(repository, {
        createdAt: at(3),
        idempotencyKey: "contract-delete-successor",
        name: "Successor",
        path: "retired/page",
      });
      await expect(repository.findArtifactByPath(["retired/page"]))
        .resolves.toEqual({id: successor.artifact.id, path: "retired/page"});
    },
  },
  {
    name: "a listing pages newest first and its cursor resumes after the last item",
    async check(repository) {
      const oldest = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-list-oldest",
        name: "Oldest",
      });
      const middle = await publishArtifact(repository, {
        createdAt: at(1),
        idempotencyKey: "contract-list-middle",
        name: "Middle",
      });
      const newest = await publishArtifact(repository, {
        createdAt: at(2),
        idempotencyKey: "contract-list-newest",
        name: "Newest",
      });
      const first = await repository.listArtifacts(listing({limit: 2}));
      expect(first.items.map((item) => item.id)).toEqual([newest.artifact.id, middle.artifact.id]);
      expect(first.items[0]).toMatchObject({
        commentCount: 0,
        currentVersionCreatedAt: at(2),
        currentVersionNumber: 1,
        versionCount: 1,
      });
      expect(first.nextCursor).not.toBeNull();
      const second = await repository.listArtifacts(listing({cursor: first.nextCursor, limit: 2}));
      expect(second.items.map((item) => item.id)).toEqual([oldest.artifact.id]);
      expect(second.nextCursor).toBeNull();
    },
  },
  {
    name: "assets commit once per key, list oldest first, count usage, and leave on delete",
    async check(repository) {
      const published = await publishArtifact(repository, {
        createdAt: at(0),
        idempotencyKey: "contract-assets-base",
        name: "Gallery",
      });
      const asset = (name: string, size: number, createdAt: string) => ({
        artifactId: published.artifact.id,
        createdAt,
        createdByDisplayName: publisher.displayName,
        createdByPrincipalId: publisher.principalId,
        id: ids.assetId(),
        mediaType: "image/png",
        name,
        projectId,
        sha256: createHash("sha256").update(name).digest("hex"),
        size,
      });
      const logo = {
        asset: asset("logo.png", 120, at(1)),
        authorizedByPrincipalId: null,
        idempotencyKey: "contract-asset-logo",
        inputDigest: "contract-asset-logo-input",
        quota: defaultAssetQuota,
        upload: null,
      };
      await expect(repository.commitAsset(logo)).resolves.toEqual({asset: logo.asset, replayed: false});
      await expect(repository.commitAsset({...logo, asset: asset("logo.png", 120, at(2))}))
        .resolves.toEqual({asset: logo.asset, replayed: true});
      await expect(repository.commitAsset({...logo, inputDigest: "contract-asset-changed-input"}))
        .rejects.toMatchObject({_tag: "IdempotencyConflict"});
      const banner = {
        ...logo,
        asset: asset("banner.png", 80, at(3)),
        idempotencyKey: "contract-asset-banner",
        inputDigest: "contract-asset-banner-input",
      };
      await repository.commitAsset(banner);
      await expect(repository.listAssets(projectId, published.artifact.id)).resolves.toEqual({
        assets: [logo.asset, banner.asset],
        usage: {assetCount: 2, byteCount: 200},
      });
      await expect(repository.deleteAsset({
        artifactId: published.artifact.id,
        assetId: logo.asset.id,
        authorizedByPrincipalId: null,
        deletedAt: at(4),
        principalId: publisher.principalId,
        projectId,
      })).resolves.toEqual(logo.asset);
      await expect(repository.readAssetUsage(published.artifact.id))
        .resolves.toEqual({assetCount: 1, byteCount: 80});
      await expect(repository.findServedAsset(logo.asset.id)).resolves.toBeNull();
      await expect(repository.findServedAsset(banner.asset.id))
        .resolves.toEqual({accessSetting: "account_required", asset: banner.asset});
    },
  },
];

/** Run one contract case against a fresh repository and always close it. */
export async function runArtifactRepositoryContractCase(
  contractCase: ArtifactRepositoryContractCase,
  openRepository: () => Promise<OpenedContractRepository>,
): Promise<void> {
  const opened = await openRepository();
  try {
    await contractCase.check(opened.repository);
  } finally {
    await opened.close();
  }
}

/** Register one test per contract case, each against a fresh repository. */
export function defineArtifactRepositoryContract(
  name: string,
  openRepository: () => Promise<OpenedContractRepository>,
): void {
  for (const contractCase of artifactRepositoryContract) {
    test(`${name}: ${contractCase.name}`, async () => {
      expect.hasAssertions();
      await runArtifactRepositoryContractCase(contractCase, openRepository);
    });
  }
}
