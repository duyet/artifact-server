import {useEffect, useState} from "react";

import {api} from "@/api/client";
import type {CatalogItem} from "../catalog/use-artifact-catalog.ts";

const debounceMilliseconds = 200;

/** One project search, and the trimmed query it answered. */
interface SearchResult {
  readonly error: Error | null;
  readonly items: readonly CatalogItem[];
  readonly query: string;
}

/** Artifact search results for the palette, plus whether they are still current. */
export interface ArtifactSearch {
  readonly error: Error | null;
  readonly items: readonly CatalogItem[];
  /** The results answer an older query; a newer one is still loading. */
  readonly stale: boolean;
}

/**
 * Search the whole project on the server, as the sidebar search does, once
 * typing pauses. An empty query lists the newest artifacts. A newer request
 * always wins over a slower earlier one.
 */
export function useArtifactSearch(projectId: string, query: string, active: boolean): ArtifactSearch {
  const trimmed = query.trim();
  const [result, setResult] = useState<SearchResult | null>(null);

  useEffect(() => {
    if (!active || projectId === "") return undefined;
    let current = true;
    const search = async (): Promise<void> => {
      try {
        const page = await api.artifacts(projectId, null, [], trimmed);
        if (current) setResult({error: null, items: page.artifacts, query: trimmed});
      } catch (caught) {
        if (current) {
          setResult({
            error: caught instanceof Error ? caught : new Error("Artifact search failed."),
            items: [],
            query: trimmed,
          });
        }
      }
    };
    const timer = window.setTimeout(() => void search(), trimmed === "" ? 0 : debounceMilliseconds);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active, projectId, trimmed]);

  return {
    error: result?.error ?? null,
    items: result?.items ?? [],
    stale: result === null || result.query !== trimmed,
  };
}
