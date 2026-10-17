import {useCallback, useDeferredValue, useEffect, useRef, useState} from "react";

import {api, type Artifact, type ArtifactOwnerScope, type ArtifactPage} from "@/api/client";
import type {CatalogCommentFilter} from "./catalog-filters.tsx";

export type CatalogItem = ArtifactPage["artifacts"][number];
export type CatalogSort = "comments" | "newest";
type LoadResult = "failed" | "loaded" | "skipped";

/** One project's artifact list with its search, filters, sort, and paging. */
export interface ArtifactCatalog {
  readonly commentFilter: CatalogCommentFilter;
  readonly error: Error | null;
  readonly filtered: boolean;
  readonly items: readonly CatalogItem[];
  readonly knownTags: readonly string[];
  readonly loadMore: () => void;
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly ownerScope: ArtifactOwnerScope;
  readonly query: string;
  readonly refresh: () => Promise<boolean>;
  readonly removeArtifact: (artifactId: string) => void;
  readonly rememberTags: (tags: readonly string[]) => void;
  readonly setCommentFilter: (filter: CatalogCommentFilter) => void;
  readonly setOwnerScope: (scope: ArtifactOwnerScope) => void;
  readonly setQuery: (query: string) => void;
  readonly setSort: (sort: CatalogSort) => void;
  readonly setTagFilters: (tags: readonly string[]) => void;
  readonly sort: CatalogSort;
  readonly tagFilters: readonly string[];
  readonly updateArtifact: (artifact: Artifact) => void;
}

/**
 * Load the artifact list for a project. A newer request always wins: a slow
 * response for an old search or project never replaces a newer one.
 */
export function useArtifactCatalog(projectId: string): ArtifactCatalog {
  const [items, setItems] = useState<readonly CatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim());
  const [commentFilter, setCommentFilter] = useState<CatalogCommentFilter>("all");
  const [tagFilters, setTagFilters] = useState<readonly string[]>([]);
  const [knownTags, setKnownTags] = useState<readonly string[]>([]);
  const [sort, setSort] = useState<CatalogSort>("newest");
  const [ownerScope, setOwnerScope] = useState<ArtifactOwnerScope>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const generationRef = useRef(0);
  const [loadedProjectId, setLoadedProjectId] = useState(projectId);

  if (loadedProjectId !== projectId) {
    setLoadedProjectId(projectId);
    setKnownTags([]);
    setTagFilters([]);
  }

  const rememberTags = useCallback((tags: readonly string[]): void => {
    if (tags.length === 0) return;
    setKnownTags((current) => [...new Set([...current, ...tags])].toSorted());
  }, []);

  const load = useCallback(async (cursor: string | null): Promise<LoadResult> => {
    if (projectId === "") return "skipped";
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.artifacts(projectId, cursor, tagFilters, searchQuery, {
        comments: commentFilter,
        owner: ownerScope,
        sort,
      });
      if (generation !== generationRef.current) return "skipped";
      rememberTags(page.artifacts.flatMap(({artifact}) => artifact.tags));
      setItems((current) => cursor === null ? page.artifacts : [...current, ...page.artifacts]);
      setNextCursor(page.nextCursor);
      return "loaded";
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(caught instanceof Error ? caught : new Error("Artifact list failed."));
      }
      return "failed";
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [commentFilter, ownerScope, projectId, rememberTags, searchQuery, sort, tagFilters]);

  useEffect(() => {
    setItems([]);
    void load(null);
  }, [load]);

  const refresh = useCallback(async (): Promise<boolean> => {
    return await load(null) === "loaded";
  }, [load]);

  const loadMore = useCallback((): void => {
    if (nextCursor !== null && !loading) void load(nextCursor);
  }, [load, loading, nextCursor]);

  const updateArtifact = useCallback((artifact: Artifact): void => {
    rememberTags(artifact.tags);
    setItems((current) => current.map((item) => item.artifact.id === artifact.id
      ? {...item, artifact}
      : item));
  }, [rememberTags]);

  const removeArtifact = useCallback((artifactId: string): void => {
    setItems((current) => current.filter(({artifact}) => artifact.id !== artifactId));
  }, []);

  return {
    commentFilter,
    error,
    filtered: query.trim() !== "" || commentFilter !== "all" || tagFilters.length > 0,
    items,
    knownTags,
    loadMore,
    loading,
    nextCursor,
    ownerScope,
    query,
    refresh,
    removeArtifact,
    rememberTags,
    setCommentFilter,
    setOwnerScope,
    setQuery,
    setSort,
    setTagFilters,
    sort,
    tagFilters,
    updateArtifact,
  };
}
