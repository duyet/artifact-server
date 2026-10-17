import type {ArtifactOwner, ArtifactOwnerScope} from "../../api/client.js";

/** The parts of an artifact catalog that decide whether it is the whole project. */
export interface OwnerCountsSource {
  readonly error: Error | null;
  readonly filtered: boolean;
  readonly items: readonly {readonly owner: ArtifactOwner}[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly ownerScope: ArtifactOwnerScope;
}

/**
 * How many artifacts each principal owns in the project, counted from the
 * loaded catalog. Null unless that catalog is the whole project: a filter,
 * a later page, or a failed load would make any count wrong.
 */
export function ownedArtifactCounts(
  catalog: OwnerCountsSource,
): ReadonlyMap<string, number> | null {
  if (
    catalog.loading
    || catalog.error !== null
    || catalog.filtered
    || catalog.nextCursor !== null
    || catalog.ownerScope !== "all"
  ) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const {owner} of catalog.items) {
    counts.set(owner.principalId, (counts.get(owner.principalId) ?? 0) + 1);
  }
  return counts;
}
