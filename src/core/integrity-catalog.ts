import {Schema} from "effect";

const artifactRowSchema = Schema.Struct({
  currentVersionId: Schema.NullOr(Schema.String),
  id: Schema.String,
  projectId: Schema.String,
});
const versionRowSchema = Schema.Struct({
  artifactId: Schema.String,
  entryPath: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
  projectId: Schema.String,
  routingMode: Schema.Literals(["static", "spa"]),
});
const projectRowSchema = Schema.Struct({id: Schema.String});
const projectReferenceRowSchema = Schema.Struct({
  artifactId: Schema.NullOr(Schema.String),
  id: Schema.String,
  kind: Schema.String,
  projectId: Schema.String,
  versionId: Schema.NullOr(Schema.String),
});
const entryRowSchema = Schema.Struct({
  disposition: Schema.String,
  mediaType: Schema.String,
  path: Schema.String,
  sha256: Schema.String,
  size: Schema.Int,
  versionId: Schema.String,
});
const assetRowSchema = Schema.Struct({
  artifactId: Schema.String,
  id: Schema.String,
  sha256: Schema.String,
  size: Schema.Int,
});

/** Parse artifact rows read by a deployment-native integrity reader. */
export const decodeArtifactRows = Schema.decodeUnknownSync(Schema.Array(artifactRowSchema));
/** Parse version rows read by a deployment-native integrity reader. */
export const decodeVersionRows = Schema.decodeUnknownSync(Schema.Array(versionRowSchema));
/** Parse manifest-entry rows read by a deployment-native integrity reader. */
export const decodeEntryRows = Schema.decodeUnknownSync(Schema.Array(entryRowSchema));
/** Parse live asset rows read by a deployment-native integrity reader. */
export const decodeAssetRows = Schema.decodeUnknownSync(Schema.Array(assetRowSchema));
/** Parse project rows read by a deployment-native integrity reader. */
export const decodeProjectRows = Schema.decodeUnknownSync(Schema.Array(projectRowSchema));
/** Parse project-scoped reference rows read by a deployment-native integrity reader. */
export const decodeProjectReferenceRows = Schema.decodeUnknownSync(
  Schema.Array(projectReferenceRowSchema),
);

/** Artifact fields required by a deployment-native integrity reader. */
export type ArtifactRow = typeof artifactRowSchema.Type;
/** Version fields required by a deployment-native integrity reader. */
export type VersionRow = typeof versionRowSchema.Type;
/** Manifest-entry fields required by a deployment-native integrity reader. */
export type EntryRow = typeof entryRowSchema.Type;
/** Live asset fields required by a deployment-native integrity reader. */
export type AssetRow = typeof assetRowSchema.Type;
/** Project fields required by a deployment-native integrity reader. */
export type ProjectRow = typeof projectRowSchema.Type;
/** Project-scoped references required by a deployment-native integrity reader. */
export type ProjectReferenceRow = typeof projectReferenceRowSchema.Type;

/** Provider-neutral catalog consumed by the shared integrity checker. */
export interface IntegrityCatalog {
  readonly artifacts: readonly ArtifactRow[];
  readonly assets: readonly AssetRow[];
  readonly entries: readonly EntryRow[];
  readonly projects: readonly ProjectRow[];
  readonly projectReferences: readonly ProjectReferenceRow[];
  readonly versions: readonly VersionRow[];
}
