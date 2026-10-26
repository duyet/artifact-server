/** One UTC day's count in a sparse daily series. */
export interface DailyCount {
  readonly count: number;
  readonly day: string;
}

/** Who can find an artifact from the tree, as the tree endpoint reports it. */
export const treeVisibilities = ["public", "unlisted", "private"] as const;

export type TreeVisibility = (typeof treeVisibilities)[number];

/** The words each visibility shows in the row menu and on a row's badge. */
export const visibilityLabels = {
  private: "Private",
  public: "Public",
  unlisted: "Unlisted",
} as const satisfies Record<TreeVisibility, string>;

/** The tag that keeps a public-link artifact out of the anonymous tree. */
export const unlistedTag = "unlisted";

/**
 * What the viewer needs to change an artifact's settings. The server sends it
 * only when it would accept the change, under the visibility API's own rule.
 */
export interface TreeManageHandle {
  readonly artifactId: string;
  readonly currentVersionId: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

/** One artifact on the home page, as the tree endpoint shapes it. */
export interface PublicArtifactTreeEntry {
  readonly manage: TreeManageHandle | null;
  /** True when the signed-in viewer owns the artifact. */
  readonly mine: boolean;
  readonly name: string;
  /** The owner's display name; null when unknown or withheld as an email. */
  readonly owner: string | null;
  /** The readable path the artifact claims, or null when it claims none. */
  readonly path: string | null;
  /** Only the days inside the window that have views, ascending. */
  readonly series: readonly DailyCount[];
  readonly updatedAt: string;
  /** Only the days inside the window that published a version, ascending. */
  readonly updates: readonly DailyCount[];
  readonly url: string;
  readonly views: {
    readonly last7Days: number;
    readonly last30Days: number;
    readonly total: number;
  };
  readonly visibility: TreeVisibility;
}

/** One folder in the tree, labelled with the last segment of its path. */
export interface PublicArtifactTreeFolder {
  readonly artifacts: readonly PublicArtifactTreeEntry[];
  readonly folders: readonly PublicArtifactTreeFolder[];
  readonly label: string;
  readonly path: string;
}

/** The whole tree, plus the artifacts that claim no path at all. */
export interface PublicArtifactTree {
  readonly folders: readonly PublicArtifactTreeFolder[];
  readonly ungrouped: readonly PublicArtifactTreeEntry[];
}

interface MutableFolder {
  readonly artifacts: PublicArtifactTreeEntry[];
  readonly children: Map<string, MutableFolder>;
  readonly label: string;
  readonly path: string;
}

/**
 * Group public artifacts by their readable paths.
 *
 * Paths are prefix-free, so a folder path is never also an artifact path and
 * every node is unambiguously a branch, a leaf, or both groups' parent. An
 * artifact with no path has no folder to nest under, so it collects in its own
 * list and the page renders that last.
 */
export function buildPublicArtifactTree(
  entries: readonly PublicArtifactTreeEntry[],
  sort: TreeSort = "updated",
): PublicArtifactTree {
  const roots = new Map<string, MutableFolder>();
  const ungrouped: PublicArtifactTreeEntry[] = [];

  for (const entry of entries) {
    const segments = entry.path?.split("/").filter((s) => s !== "") ?? [];
    const leaf = segments.pop();
    if (leaf === undefined) {
      ungrouped.push(entry);
      continue;
    }
    // A one-segment path has no parent folder. Because paths are prefix-free,
    // nothing else can live under that segment, so it becomes a group that
    // holds exactly this artifact.
    const holder = segmentFolder(roots, segments.length === 0 ? [leaf] : segments);
    holder.artifacts.push(entry);
  }

  return {
    folders: sortFolders(roots.values(), sort),
    ungrouped: ungrouped.toSorted(treeSortOrders[sort].entries),
  };
}

/** The folder at `segments`, creating every missing ancestor along the way. */
function segmentFolder(
  roots: Map<string, MutableFolder>,
  segments: readonly string[],
): MutableFolder {
  let siblings = roots;
  let folder: MutableFolder | undefined;
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    folder = siblings.get(prefix);
    if (folder === undefined) {
      folder = {artifacts: [], children: new Map(), label: segment, path: prefix};
      siblings.set(prefix, folder);
    }
    siblings = folder.children;
  }
  // Every call passes at least one segment, so the loop always sets `folder`.
  if (folder === undefined) throw new Error("A tree folder needs one segment.");
  return folder;
}

/** The inclusive day list a window covers, newest last. */
export function windowDays(untilDay: string, count: number): readonly string[] {
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(shiftDay(untilDay, -offset));
  }
  return days;
}

/**
 * Expand a sparse ascending series into one count per day of the window, so a
 * chart can place a bar at a day instead of inferring where days went missing.
 */
export function densifyDailySeries(
  series: readonly DailyCount[],
  days: readonly string[],
): readonly number[] {
  const counts = new Map(series.map((row) => [row.day, row.count]));
  return days.map((day) => counts.get(day) ?? 0);
}

/** The per-day measures the page chart can show. */
export type DailyMetric = "updates" | "views";

/** Where each measure's sparse series lives on an artifact. */
const dailySeries = {
  updates: (entry: PublicArtifactTreeEntry) => entry.updates,
  views: (entry: PublicArtifactTreeEntry) => entry.series,
} satisfies Record<
  DailyMetric,
  (entry: PublicArtifactTreeEntry) => readonly DailyCount[]
>;

/** Sum every artifact's sparse series of one measure into one for the page chart. */
export function sumDailySeries(
  entries: readonly PublicArtifactTreeEntry[],
  metric: DailyMetric,
): readonly DailyCount[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    for (const row of dailySeries[metric](entry)) {
      totals.set(row.day, (totals.get(row.day) ?? 0) + row.count);
    }
  }
  return [...totals]
    .map(([day, count]) => ({count, day}))
    .toSorted((left, right) => left.day.localeCompare(right.day));
}

/**
 * The artifacts that count at least once on `day` in one measure. Building the
 * tree from this list keeps exactly the folders that hold a match.
 */
export function entriesOnDay(
  entries: readonly PublicArtifactTreeEntry[],
  metric: DailyMetric,
  day: string,
): readonly PublicArtifactTreeEntry[] {
  return entries.filter((entry) =>
    dailySeries[metric](entry).some((row) => row.day === day && row.count > 0)
  );
}

/** How strongly one day's bar wears its measure's accent. */
export type DayTone = "full" | "hover" | "muted";

/**
 * The tone of one day's bar. The selected day keeps the full accent and the
 * day under the pointer or keyboard sits one step below it. With a day
 * selected the rest recede to a tint; with none, every bar is full.
 */
export function dayTone(
  day: string,
  selected: string | null,
  active: string | null,
): DayTone {
  if (day === selected) return "full";
  if (day === active) return "hover";
  return selected === null ? "full" : "muted";
}

/**
 * The day with the most counts in a dense window, or null when every day is
 * zero. A tie goes to the latest day, the one a reader most likely means.
 */
export function busiestDay(
  values: readonly number[],
  days: readonly string[],
): DailyCount | null {
  let busiest: DailyCount | null = null;
  for (const [index, day] of days.entries()) {
    const count = values[index] ?? 0;
    if (count > 0 && count >= (busiest?.count ?? 0)) busiest = {count, day};
  }
  return busiest;
}

/** One bar's place and height inside a fixed chart box. */
export interface SparklineBar {
  readonly height: number;
  readonly width: number;
  readonly x: number;
}

/** The box every chart on the page is drawn in. */
export const sparklineBox = {gap: 1, height: 24, width: 96} as const;

/**
 * Lay out one bar per value, scaled to the tallest. A series with no views
 * produces zero-height bars rather than an empty box, so a column of rows stays
 * aligned instead of collapsing.
 */
export function sparklineBars(
  values: readonly number[],
  box: {readonly gap: number; readonly height: number; readonly width: number},
): readonly SparklineBar[] {
  if (values.length === 0) return [];
  const totalGap = box.gap * (values.length - 1);
  const width = Math.max(1, (box.width - totalGap) / values.length);
  // A floor of 1 keeps an all-zero series from dividing by zero, and a flat
  // one from being drawn at an arbitrary height.
  const tallest = Math.max(1, ...values);
  return values.map((value, index) => ({
    height: Math.round((Math.max(0, value) / tallest) * box.height),
    width,
    x: index * (width + box.gap),
  }));
}

/** One calendar day, `days` after or before `day`, as `YYYY-MM-DD`. */
function shiftDay(day: string, days: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/**
 * Sort sibling folders and, inside each, its artifacts by one order. Folders
 * keep grouping: a sort reorders within a folder and never across folders.
 */
function sortFolders(
  folders: Iterable<MutableFolder>,
  sort: TreeSort,
): readonly PublicArtifactTreeFolder[] {
  return [...folders]
    .map((folder): PublicArtifactTreeFolder => ({
      artifacts: folder.artifacts.toSorted(treeSortOrders[sort].entries),
      folders: sortFolders(folder.children.values(), sort),
      label: folder.label,
      path: folder.path,
    }))
    .toSorted(treeSortOrders[sort].folders);
}

/** Every artifact anywhere beneath a folder. */
function entriesBeneath(folder: PublicArtifactTreeFolder): readonly PublicArtifactTreeEntry[] {
  return [...folder.artifacts, ...folder.folders.flatMap(entriesBeneath)];
}

function newestUpdatedAt(folder: PublicArtifactTreeFolder): string {
  return entriesBeneath(folder).reduce(
    (latest, entry) => (entry.updatedAt > latest ? entry.updatedAt : latest),
    "",
  );
}

function totalViews(folder: PublicArtifactTreeFolder): number {
  return entriesBeneath(folder).reduce((sum, entry) => sum + entry.views.total, 0);
}

/**
 * Newest first. `url` breaks ties so the order is total: two versions
 * published in the same millisecond still land in a fixed order.
 */
function newestEntriesFirst(left: PublicArtifactTreeEntry, right: PublicArtifactTreeEntry): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return left.url.localeCompare(right.url);
}

/** The orders a reader can pick for the tree. */
export const treeSorts = ["updated", "name", "views"] as const;

export type TreeSort = (typeof treeSorts)[number];

/**
 * Each order, for artifacts and for the folders that hold them. A folder
 * sorts by what lies beneath it: its newest artifact, its total views, or
 * its own label.
 */
const treeSortOrders = {
  name: {
    entries: (left, right) =>
      left.name.localeCompare(right.name, undefined, {sensitivity: "base"}) ||
      left.url.localeCompare(right.url),
    folders: (left, right) => left.label.localeCompare(right.label),
  },
  updated: {
    entries: newestEntriesFirst,
    folders: (left, right) => {
      const leftNewest = newestUpdatedAt(left);
      const rightNewest = newestUpdatedAt(right);
      if (leftNewest !== rightNewest) return leftNewest < rightNewest ? 1 : -1;
      return left.label.localeCompare(right.label);
    },
  },
  views: {
    entries: (left, right) =>
      right.views.total - left.views.total || newestEntriesFirst(left, right),
    folders: (left, right) =>
      totalViews(right) - totalViews(left) || left.label.localeCompare(right.label),
  },
} as const satisfies Record<TreeSort, {
  readonly entries: (left: PublicArtifactTreeEntry, right: PublicArtifactTreeEntry) => number;
  readonly folders: (left: PublicArtifactTreeFolder, right: PublicArtifactTreeFolder) => number;
}>;

/** The two settings writes one visibility change needs; null skips a write. */
export interface VisibilityWrites {
  readonly accessSetting: "account_required" | "public_link" | null;
  readonly tags: readonly string[] | null;
}

/**
 * The writes that move an artifact from its visibility to `target`. Private
 * is the access setting; unlisted is a public link with the unlisted tag. The
 * tags are written before the access, so a change never passes through a
 * state that lists the artifact more widely than either end.
 */
export function visibilityWrites(
  current: {readonly tags: readonly string[]; readonly visibility: TreeVisibility},
  target: TreeVisibility,
): VisibilityWrites {
  const tagged = current.tags.includes(unlistedTag);
  const accessSetting = target === "private"
    ? (current.visibility === "private" ? null : "account_required")
    : (current.visibility === "private" ? "public_link" : null);
  let tags: readonly string[] | null = null;
  if (target === "unlisted" && !tagged) tags = [...current.tags, unlistedTag].toSorted();
  if (target === "public" && tagged) tags = current.tags.filter((tag) => tag !== unlistedTag);
  return {accessSetting, tags};
}
