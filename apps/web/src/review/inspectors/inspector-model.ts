import {ancestorFolderPaths, buildPathTree, type PathTreeNode} from "../../lib/path-tree.ts";

export interface ChangedFile {
  readonly kind: "Added" | "Changed" | "Removed" | "Renamed";
  readonly path: string;
}

interface PathRef {
  readonly path: string;
}

/** The parts of an `ArtifactComparison` that name files. */
export interface ComparisonPaths {
  readonly added: readonly PathRef[];
  readonly changed: readonly {readonly after: PathRef}[];
  readonly removed: readonly PathRef[];
  readonly renamed: readonly {readonly from: PathRef; readonly to: PathRef}[];
}

/** Every file a comparison touched, grouped by kind in a stable order. */
export function changedFiles(comparison: ComparisonPaths): readonly ChangedFile[] {
  return [
    ...comparison.added.map((entry): ChangedFile => ({kind: "Added", path: entry.path})),
    ...comparison.changed.map((entry): ChangedFile => ({kind: "Changed", path: entry.after.path})),
    ...comparison.removed.map((entry): ChangedFile => ({kind: "Removed", path: entry.path})),
    ...comparison.renamed.map((entry): ChangedFile => ({
      kind: "Renamed",
      path: `${entry.from.path} → ${entry.to.path}`,
    })),
  ];
}

/** Turn the comma separated tags field into the complete tag set to save. */
export function parseTagList(value: string): readonly string[] {
  return value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
}

/** Nest manifest entries into folders, sorted by path so the tree order is stable. */
export function buildFileTree<Entry extends {readonly path: string}>(
  entries: readonly Entry[],
): readonly PathTreeNode<Entry>[] {
  const sorted = entries.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return buildPathTree(sorted, (entry) => entry.path.split("/"));
}

/** Folders that must be open so the selected file is visible. */
export function foldersToReveal(selectedPath: string): ReadonlySet<string> {
  return new Set(ancestorFolderPaths(selectedPath));
}
