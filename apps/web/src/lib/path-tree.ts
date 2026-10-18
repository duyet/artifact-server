/** One folder in a path tree, named by its last segment. */
export interface PathTreeFolder<Item> {
  readonly children: readonly PathTreeNode<Item>[];
  readonly kind: "folder";
  readonly name: string;
  /** Every segment from the root to this folder, joined with "/". */
  readonly path: string;
}

/** One item in a path tree, named by the last segment of its path. */
export interface PathTreeLeaf<Item> {
  readonly item: Item;
  readonly kind: "leaf";
  readonly name: string;
  readonly path: string;
}

export type PathTreeNode<Item> = PathTreeFolder<Item> | PathTreeLeaf<Item>;

interface MutableFolder<Item> {
  readonly folders: Map<string, MutableFolder<Item>>;
  readonly leaves: PathTreeLeaf<Item>[];
  readonly name: string;
  readonly path: string;
}

/**
 * Nest items under folders named by their path segments.
 *
 * Folders come before leaves at every level. Both keep the order in which the
 * input first reached them, so callers choose the order by sorting the input.
 * Leaves are never merged: two items with the same path stay two leaves.
 */
export function buildPathTree<Item>(
  items: readonly Item[],
  segmentsOf: (item: Item) => readonly string[],
): readonly PathTreeNode<Item>[] {
  const root: MutableFolder<Item> = {folders: new Map(), leaves: [], name: "", path: ""};
  for (const item of items) {
    const segments = segmentsOf(item).filter((segment) => segment !== "");
    const name = segments.at(-1);
    if (name === undefined) continue;
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = {
          folders: new Map(),
          leaves: [],
          name: segment,
          path: folder.path === "" ? segment : `${folder.path}/${segment}`,
        };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.leaves.push({item, kind: "leaf", name, path: segments.join("/")});
  }
  return freeze(root);
}

function freeze<Item>(folder: MutableFolder<Item>): readonly PathTreeNode<Item>[] {
  return [
    ...[...folder.folders.values()].map((child): PathTreeFolder<Item> => ({
      children: freeze(child),
      kind: "folder",
      name: child.name,
      path: child.path,
    })),
    ...folder.leaves,
  ];
}

/** The path of every folder on the way to `path`, nearest the root first. */
export function ancestorFolderPaths(path: string): readonly string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}
