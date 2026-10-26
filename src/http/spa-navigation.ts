const navigationDestinations: ReadonlySet<string> = new Set([
  "document",
  "frame",
  "iframe",
]);

/**
 * Decide whether a missing path may resolve to a single-page application's
 * HTML entry file.
 */
export function permitsSpaEntryFallback(headers: Headers): boolean {
  if (!acceptsHtml(headers.get("accept"))) return false;
  const destination = headers.get("sec-fetch-dest")?.toLowerCase() ?? null;
  // The viewer frames a readable URL, so a client route opened there is a
  // frame's navigation, not a tab's.
  if (destination !== null && !navigationDestinations.has(destination)) {
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
