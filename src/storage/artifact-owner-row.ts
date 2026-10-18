import {z} from "zod";

import type {ArtifactOwner} from "../core/model.js";
import type {ArtifactOwnerFilter} from "../core/ports.js";

/**
 * The flat owner columns every artifact row query selects. SQL returns flat
 * columns, so each backend reads these two and nests them with
 * `withArtifactOwner` rather than repeating the projection.
 */
export const artifactOwnerColumns = {
  ownerDisplayName: z.string().nullable(),
  ownerPrincipalId: z.string(),
};

interface ArtifactOwnerColumns {
  readonly ownerDisplayName: string | null;
  readonly ownerPrincipalId: string;
}

/** Replace a row's flat owner columns with the nested artifact owner. */
export function withArtifactOwner<Row extends ArtifactOwnerColumns>(
  row: Row,
): Omit<Row, keyof ArtifactOwnerColumns> & {readonly owner: ArtifactOwner} {
  const {ownerDisplayName, ownerPrincipalId, ...rest} = row;
  return {
    ...rest,
    owner: {displayName: ownerDisplayName, principalId: ownerPrincipalId},
  };
}

/**
 * The two nullable bind values an owner filter becomes. A query keeps a row
 * when `ownedBy` is null or matches, and `notOwnedBy` is null or differs.
 */
export interface OwnerFilterParameters {
  readonly notOwnedBy: string | null;
  readonly ownedBy: string | null;
}

/** Bind one owner filter as the two nullable values every backend queries. */
export function ownerFilterParameters(
  filter: ArtifactOwnerFilter,
): OwnerFilterParameters {
  return {
    notOwnedBy: filter.kind === "not_owned_by" ? filter.principalId : null,
    ownedBy: filter.kind === "owned_by" ? filter.principalId : null,
  };
}
