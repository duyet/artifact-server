/** One artifact on the public home page, as the tree endpoint shapes it. */
export interface PublicArtifactTreeEntry {
  readonly name: string;
  /** The readable path the artifact claims, or null when it claims none. */
  readonly path: string | null;
  /** Only the days inside the window that have views, ascending. */
  readonly series: readonly {count: number; day: string}[];
  readonly updatedAt: string;
  readonly url: string;
  readonly views: {
    readonly last7Days: number;
    readonly last30Days: number;
    readonly total: number;
  };
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
    folders: newestFoldersFirst(roots.values()),
    ungrouped: newestEntriesFirst(ungrouped),
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
  series: readonly {count: number; day: string}[],
  days: readonly string[],
): readonly number[] {
  const counts = new Map(series.map((row) => [row.day, row.count]));
  return days.map((day) => counts.get(day) ?? 0);
}

/** Sum every artifact's sparse series into one series for the page chart. */
export function sumDailySeries(
  entries: readonly PublicArtifactTreeEntry[],
): readonly {count: number; day: string}[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    for (const row of entry.series) {
      totals.set(row.day, (totals.get(row.day) ?? 0) + row.count);
    }
  }
  return [...totals]
    .map(([day, count]) => ({count, day}))
    .toSorted((left, right) => left.day.localeCompare(right.day));
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
 * Newest first. `url` breaks ties so the order is total: two versions
 * published in the same millisecond still land in a fixed order.
 */
function newestEntriesFirst(
  entries: readonly PublicArtifactTreeEntry[],
): readonly PublicArtifactTreeEntry[] {
  return entries.toSorted((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }
    return left.url.localeCompare(right.url);
  });
}

/** A folder sorts by the newest artifact anywhere beneath it. */
function newestFoldersFirst(
  folders: Iterable<MutableFolder>,
): readonly PublicArtifactTreeFolder[] {
  return [...folders]
    .map((folder) => toTreeFolder(folder))
    .toSorted((left, right) => {
      const leftNewest = newestUpdatedAt(left);
      const rightNewest = newestUpdatedAt(right);
      if (leftNewest !== rightNewest) return leftNewest < rightNewest ? 1 : -1;
      return left.label.localeCompare(right.label);
    });
}

function toTreeFolder(folder: MutableFolder): PublicArtifactTreeFolder {
  return {
    artifacts: newestEntriesFirst(folder.artifacts),
    folders: newestFoldersFirst(folder.children.values()),
    label: folder.label,
    path: folder.path,
  };
}

function newestUpdatedAt(folder: PublicArtifactTreeFolder): string {
  const dates = [
    ...folder.artifacts.map((artifact) => artifact.updatedAt),
    ...folder.folders.map(newestUpdatedAt),
  ];
  return dates.reduce(
    (latest, date) => (date > latest ? date : latest),
    "",
  );
}