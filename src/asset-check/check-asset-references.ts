import type {ManifestEntry, RoutingMode} from "../core/model.js";
import {manifestPathFromUrl} from "../manifest/create-manifest.js";
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

/** The references one file makes, before they are resolved. */
export interface ScannedAssetSource {
  /** The document's `<base href>`; always null outside HTML. */
  readonly baseHref: string | null;
  readonly language: AssetSourceLanguage;
  readonly path: string;
  readonly references: readonly ScannedReference[];
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
  readonly sources: readonly ScannedAssetSource[];
  /** The scan plan already skipped files because of a limit. */
  readonly truncated: boolean;
}

// Scanning is synchronous, so the file limit bounds how long one scan holds
// the event loop and the version limit bounds what a commit waits for.
export const assetCheckLimits = {
  maximumFileBytes: 1_024 * 1_024,
  maximumFiles: 1_000,
  maximumReferences: 1_000,
  maximumVersionBytes: 8 * 1_024 * 1_024,
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

/** Extract one file's references; linear in the file's length. */
export function scanAssetSource(source: AssetSource): ScannedAssetSource {
  if (source.language === "html") {
    const document = scanHtml(source.text);
    return {...document, language: source.language, path: source.path};
  }
  return {
    baseHref: null,
    language: source.language,
    path: source.path,
    references: source.language === "css" ? scanCss(source.text) : scanScript(source.text),
  };
}

/** Report every reference in the scanned files that the manifest cannot satisfy. */
export function checkAssetReferences(input: AssetCheckInput): AssetCheckReport {
  const manifestPaths = new Set(input.manifestPaths);
  const roots = input.servedRoots.toSorted((left, right) => right.length - left.length);
  const primaryRoot = new URL(input.servedRoots[0], syntheticOrigin);
  const broken: BrokenAssetReference[] = [];
  let truncated = input.truncated;

  const locate = (url: URL): LocatedPath => {
    const pathname = url.pathname;
    for (const root of roots) {
      if (pathname === root.slice(0, -1)) return {path: "", servable: true, within: true};
      if (pathname.startsWith(root)) {
        // The server's own URL-to-path rule, so encoded separators and
        // non-NFC names count as missing exactly as they 404 there.
        const relative = `/${pathname.slice(root.length)}`;
        const servable = manifestPathFromUrl(relative);
        return servable === null
          ? {path: decodePath(relative.slice(1)), servable: false, within: true}
          : {path: servable, servable: true, within: true};
      }
    }
    return {path: decodePath(pathname), servable: false, within: false};
  };

  const satisfied = (located: LocatedPath, reference: ScannedReference): boolean =>
    located.within && (
      (reference.navigation && input.routingMode === "spa") ||
      (located.servable && (located.path === "" || manifestPaths.has(located.path)))
    );

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
    if (located.some((candidate) => satisfied(candidate, reference))) {
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
    // The shared link serves the entry file at the root itself.
    const fileUrl = source.path === input.entryPath
      ? primaryRoot
      : new URL(encodePath(source.path), primaryRoot);
    const base = source.baseHref === null
      ? fileUrl
      : URL.parse(source.baseHref.trim(), fileUrl) ?? fileUrl;
    // Paths in a script file usually resolve against the page that loads it.
    const bases = source.language === "script" ? [fileUrl, primaryRoot] : [base];
    for (const reference of source.references) check(source.path, reference, bases);
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
  /** The server would map this URL to a manifest path at all. */
  readonly servable: boolean;
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
