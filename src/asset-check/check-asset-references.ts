import type {ManifestEntry, RoutingMode} from "../core/model.js";
import {
  scanCss,
  scanHtml,
  scanScript,
  type ScannedReference,
  type ScannedReferenceKind,
} from "./scan-asset-references.js";

/** How a reference is loaded, or `outside` when it leaves the artifact's served path. */
export type AssetReferenceKind = ScannedReferenceKind | "outside";

/** Whether a reported reference is certainly broken or only probably broken. */
export type AssetReferenceConfidence = "certain" | "heuristic";

/** One reference the version's own files do not satisfy. */
export interface BrokenAssetReference {
  readonly confidence: AssetReferenceConfidence;
  readonly file: string;
  readonly kind: AssetReferenceKind;
  readonly line: number | null;
  readonly raw: string;
  /** The manifest path the reference asks for, or the URL path when it is outside. */
  readonly resolvedPath: string;
}

/** Counts over one version's broken references. */
export interface AssetCheckSummary {
  readonly broken: number;
  readonly byKind: Readonly<Record<AssetReferenceKind, number>>;
  readonly checkedFiles: number;
  readonly heuristic: number;
  /** A file, byte, or reference limit stopped the check before it saw everything. */
  readonly truncated: boolean;
}

/** The broken references of one version and their summary. */
export interface AssetCheckReport {
  readonly references: readonly BrokenAssetReference[];
  readonly summary: AssetCheckSummary;
}

/** The language a scanned file is read as. */
export type AssetSourceLanguage = "css" | "html" | "script";

/** One manifest file selected for scanning. */
export interface PlannedAssetSource {
  readonly entry: ManifestEntry;
  readonly language: AssetSourceLanguage;
}

/** One scanned file's decoded text. */
export interface AssetSource {
  readonly language: AssetSourceLanguage;
  readonly path: string;
  readonly text: string;
}

/** The files chosen for scanning and whether a limit left some out. */
export interface AssetScanPlan {
  readonly sources: readonly PlannedAssetSource[];
  readonly truncated: boolean;
}

/** Everything the checker needs about one version. */
export interface AssetCheckInput {
  readonly entryPath: string;
  readonly manifestPaths: readonly string[];
  readonly routingMode: RoutingMode;
  /**
   * URL paths, each ending in `/`, at which this version's files are served on
   * one origin. The first is the base relative references resolve against.
   */
  readonly servedRoots: readonly [string, ...string[]];
  readonly sources: readonly AssetSource[];
  /** The scan plan already skipped files because of a limit. */
  readonly truncated: boolean;
}

export const assetCheckLimits = {
  maximumFileBytes: 2 * 1_024 * 1_024,
  maximumFiles: 1_000,
  maximumReferences: 1_000,
  maximumVersionBytes: 32 * 1_024 * 1_024,
} as const;

const syntheticOrigin = "https://artifact.invalid";
const languageByMediaType: ReadonlyMap<string, AssetSourceLanguage> = new Map([
  ["application/ecmascript", "script"],
  ["application/javascript", "script"],
  ["application/xhtml+xml", "html"],
  ["text/css", "css"],
  ["text/ecmascript", "script"],
  ["text/html", "html"],
  ["text/javascript", "script"],
]);
const languageByExtension: ReadonlyMap<string, AssetSourceLanguage> = new Map([
  ["css", "css"],
  ["htm", "html"],
  ["html", "html"],
  ["js", "script"],
  ["mjs", "script"],
]);

/** Pick the HTML, CSS, and JavaScript files to scan, within the per-file and per-version limits. */
export function planAssetSources(entries: readonly ManifestEntry[]): AssetScanPlan {
  const sources: PlannedAssetSource[] = [];
  let truncated = false;
  let totalBytes = 0;
  for (const entry of entries) {
    const language = sourceLanguage(entry);
    if (language === null) continue;
    if (
      entry.size > assetCheckLimits.maximumFileBytes ||
      totalBytes + entry.size > assetCheckLimits.maximumVersionBytes ||
      sources.length === assetCheckLimits.maximumFiles
    ) {
      truncated = true;
      continue;
    }
    totalBytes += entry.size;
    sources.push({entry, language});
  }
  return {sources, truncated};
}

/** Report every reference in the scanned files that the manifest cannot satisfy. */
export function checkAssetReferences(input: AssetCheckInput): AssetCheckReport {
  const manifestPaths = new Set(input.manifestPaths);
  const roots = input.servedRoots.toSorted((left, right) => right.length - left.length);
  const primaryRoot = new URL(input.servedRoots[0], syntheticOrigin);
  const entryUrl = new URL(encodePath(input.entryPath), primaryRoot);
  const broken: BrokenAssetReference[] = [];
  let truncated = input.truncated;

  const locate = (url: URL): LocatedPath => {
    const pathname = url.pathname;
    for (const root of roots) {
      if (pathname === root.slice(0, -1)) return {path: "", within: true};
      if (pathname.startsWith(root)) {
        return {path: decodePath(pathname.slice(root.length)), within: true};
      }
    }
    return {path: decodePath(pathname), within: false};
  };

  const satisfied = (path: string, reference: ScannedReference): boolean =>
    path === "" ||
    manifestPaths.has(path) ||
    (reference.navigation && input.routingMode === "spa");

  const check = (file: string, reference: ScannedReference, bases: readonly URL[]): void => {
    const value = reference.raw.trim();
    if (value === "" || value.startsWith("#") || value.includes("${") || value.includes("{{")) {
      return;
    }
    const located = bases.flatMap((base) => {
      const url = URL.parse(value, base);
      return url === null || url.origin !== syntheticOrigin ? [] : [locate(url)];
    });
    const first = located[0];
    if (first === undefined) return;
    if (located.some((candidate) => candidate.within && satisfied(candidate.path, reference))) {
      return;
    }
    if (broken.length === assetCheckLimits.maximumReferences) {
      truncated = true;
      return;
    }
    broken.push({
      confidence: !first.within || reference.kind === "script" ? "heuristic" : "certain",
      file,
      kind: first.within ? reference.kind : "outside",
      line: reference.line,
      raw: reference.raw,
      resolvedPath: first.path,
    });
  };

  for (const source of input.sources) {
    const fileUrl = new URL(encodePath(source.path), primaryRoot);
    if (source.language === "html") {
      const document = scanHtml(source.text);
      const base = document.baseHref === null
        ? fileUrl
        : URL.parse(document.baseHref.trim(), fileUrl) ?? fileUrl;
      for (const reference of document.references) check(source.path, reference, [base]);
    } else if (source.language === "css") {
      for (const reference of scanCss(source.text)) check(source.path, reference, [fileUrl]);
    } else {
      // Paths in a script file usually resolve against the page that loads it.
      for (const reference of scanScript(source.text)) {
        check(source.path, reference, [fileUrl, entryUrl]);
      }
    }
  }

  const byKind = {
    "css-import": 0,
    "css-url": 0,
    "html-attr": 0,
    "meta-refresh": 0,
    outside: 0,
    script: 0,
  } satisfies Record<AssetReferenceKind, number>;
  for (const reference of broken) byKind[reference.kind] += 1;
  const heuristic = broken.filter((reference) => reference.confidence === "heuristic").length;
  return {
    references: broken,
    summary: {
      broken: broken.length - heuristic,
      byKind,
      checkedFiles: input.sources.length,
      heuristic,
      truncated,
    },
  };
}

/** A resolved URL path, relative to the served root it falls under when `within`. */
interface LocatedPath {
  readonly path: string;
  readonly within: boolean;
}

function sourceLanguage(entry: ManifestEntry): AssetSourceLanguage | null {
  const essence = entry.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = /\.([a-z0-9]+)$/iu.exec(entry.path)?.[1]?.toLowerCase() ?? "";
  return languageByMediaType.get(essence) ?? languageByExtension.get(extension) ?? null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
