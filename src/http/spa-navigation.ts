/** A tab's navigation, the only one most content forms answer with the entry file. */
export const tabNavigation: ReadonlySet<string> = new Set(["document"]);

/**
 * The viewer frames a readable URL's page, so a client route opened there is
 * a frame's navigation as well as a tab's.
 */
export const tabOrFrameNavigation: ReadonlySet<string> = new Set([
  "document",
  "frame",
  "iframe",
]);

/**
 * Decide whether a missing path may resolve to a single-page application's
 * HTML entry file, for a navigation to one of `destinations`.
 */
export function permitsSpaEntryFallback(
  headers: Headers,
  destinations: ReadonlySet<string>,
): boolean {
  if (!acceptsHtml(headers.get("accept"))) return false;
  const destination = headers.get("sec-fetch-dest")?.toLowerCase() ?? null;
  if (destination !== null && !destinations.has(destination)) {
    return false;
  }
  const mode = headers.get("sec-fetch-mode");
  return mode === null || mode.toLowerCase() === "navigate";
}

function acceptsHtml(accept: string | null): boolean {
  if (accept === null) return false;
  return accept.split(",").some((candidate) => {
    const [mediaRange, ...parameters] = candidate.trim().toLowerCase().split(";");
    if (mediaRange !== "text/html") return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.trim().slice(2));
    return Number.isFinite(value) && value > 0;
  });
}
