import {z} from "zod";

import {AssetNotFound, IdempotencyConflict} from "../core/errors.js";
import {accessSettings} from "../core/model.js";
import type {CommittedAsset} from "../core/ports.js";

const nonnegativeIntegerSchema = z.coerce.number().int().nonnegative();

/** One asset row as both SQL backends select it. */
export const assetRowSchema = z.object({
  artifactId: z.string(),
  createdAt: z.string(),
  createdByDisplayName: z.string(),
  createdByPrincipalId: z.string(),
  id: z.string(),
  mediaType: z.string(),
  name: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
});

/** The columns an asset query selects, under the names `assetRowSchema` reads. */
export const assetColumns = `asset.id AS "id",
  asset.project_id AS "projectId",
  asset.artifact_id AS "artifactId",
  asset.media_type AS "mediaType",
  asset.size AS "size",
  asset.sha256 AS "sha256",
  asset.name AS "name",
  asset.created_by_principal_id AS "createdByPrincipalId",
  asset.created_by_display_name AS "createdByDisplayName",
  asset.created_at AS "createdAt"`;

/** An asset row an idempotent replay found, with what it was bound to. */
export const assetReplayRowSchema = assetRowSchema.extend({
  deletedAt: z.string().nullable(),
  inputDigest: z.string(),
});

/** One artifact's live asset count and bytes. */
export const assetUsageRowSchema = z.object({
  assetCount: nonnegativeIntegerSchema,
  byteCount: nonnegativeIntegerSchema,
});

/** A live asset joined to the access of its live artifact. */
export const servedAssetRowSchema = assetRowSchema.extend({
  accessSetting: z.enum([accessSettings.accountRequired, accessSettings.publicLink]),
});

/**
 * The result a key that already committed an asset replays. A key bound to
 * other input is a conflict, and a key whose asset was deleted since names
 * nothing a caller could use.
 */
export function replayedAsset(
  found: z.infer<typeof assetReplayRowSchema>,
  inputDigest: string,
): CommittedAsset {
  const {deletedAt, inputDigest: boundDigest, ...asset} = found;
  if (boundDigest !== inputDigest) {
    throw new IdempotencyConflict({
      message: "The idempotency key was already used with different input.",
    });
  }
  if (deletedAt !== null) {
    throw new AssetNotFound({message: "The asset this key created was deleted."});
  }
  return {asset, replayed: true};
}
