import type {ArtifactOwner} from "@/api/client";
import type {ArtifactCatalog} from "./use-artifact-catalog.ts";

/**
 * How many artifacts each principal owns in the project, counted from the
 * loaded catalog. Null unless that catalog is the whole project: a filter,
 * a later page, or a failed load would make any count wrong.
 */
export function ownedArtifactCounts(
  catalog: Pick<ArtifactCatalog, "error" | "filtered" | "loading" | "nextCursor" | "ownerScope"> & {
    readonly items: readonly {readonly owner: ArtifactOwner}[];
  },
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
