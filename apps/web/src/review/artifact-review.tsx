import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {IconArrowsMinimize, IconBook, IconBrandGithub, IconCheck, IconChevronLeft, IconChevronRight, IconExternalLink, IconHome, IconLayoutSidebar, IconLayoutSidebarRight, IconMaximize, IconMessage, IconMoon, IconPencil, IconRefresh, IconSearch, IconSettings, IconSun, IconX} from "@tabler/icons-react";
import {Dialog} from "@base-ui/react/dialog";
import {motion} from "motion/react";

import {writeDraft} from "@/components/comments/comment-drafts";
import {useCommentPoll} from "@/components/comments/comment-poll";
import {
  api,
  ApiError,
  type ArtifactAction,
  type ArtifactComparison,
  type ArtifactDetails,
  type ArtifactPage,
  type ArtifactVersion,
  type Project,
  type Session,
} from "@/api/client";
import {formatTimestamp} from "@/lib/presentation";
import artifactServerAnimationUrl from "./assets/artifact-server.svg";
import {ArtifactMark} from "./artifact-mark.tsx";
import {CatalogFilters, type CatalogCommentFilter} from "./catalog/catalog-filters.tsx";
import {ActivityInspector, ComparisonInspector} from "./inspectors/activity-inspector.tsx";
import {DetailsInspector} from "./inspectors/details-inspector.tsx";
import {FilesInspector} from "./inspectors/files-inspector.tsx";
import {InspectorTabButton, type InspectorTab} from "./inspectors/inspector-layout.tsx";
import {VersionsInspector, type VersionListItem} from "./inspectors/versions-inspector.tsx";
import {
  useReviewComments,
  ReviewCommentsInspector,
  type ReviewCommentsInspectorHandle,
} from "./review-comments.tsx";
import {ReviewDownloadControl, reviewDownload} from "./review-download.tsx";
import {readReviewLocation, reviewHref, reviewPreviewKind} from "./review-location.ts";
import {ReviewPreview} from "./review-preview.tsx";
import {AccessPill, IconButton, InlineState, PreviewWelcome} from "./review-primitives.tsx";
import {ReviewProjectPicker} from "./review-project-picker.tsx";
import {ReviewPanelEdge} from "./review-panel-edge.tsx";
import {AgentLogos, ReviewShareControl} from "./review-share.tsx";
import {ReviewKeyboardShortcuts, reviewShortcutBlocked} from "./review-shortcuts.tsx";
import {useReviewPanelMotion} from "./use-review-panel-motion.ts";
import {useReviewResizablePanel} from "./use-review-resizable-panel.ts";
import {useWebmcp, type WebmcpBindings} from "./webmcp.tsx";

export type ReviewTheme = "dawn" | "moon";

type ArtifactListLoadResult = "failed" | "loaded" | "skipped";

type CatalogRefreshState = "complete" | "idle" | "loading";
type CatalogSort = "comments" | "newest";
const catalogDefaultWidth = 336;
const catalogMinimumWidth = 240;
const catalogMaximumWidth = 520;
const inspectorDefaultWidth = 352;
const inspectorMinimumWidth = 240;
const inspectorMaximumWidth = 480;
const inspectorGapPixels = 12;
const catalogRefreshConfirmationMilliseconds = 1_600;

/** Browse, preview, and inspect one project's artifacts. */
export function ArtifactReview({
  onCreateProject,
  onThemeChange,
  projects,
  session,
  theme,
}: {
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly session: Session;
  readonly theme: ReviewTheme;
}) {
  const initialLocation = useMemo(readReviewLocation, []);
  const initialProjectId = initialLocation.projectId
    ?? projects.find((project) => project.archivedAt === null)?.id
    ?? projects[0]?.id
    ?? "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const [items, setItems] = useState<ArtifactPage["artifacts"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    initialLocation.artifactId,
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    initialLocation.versionId,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialLocation.path,
  );
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim());
  const [catalogCommentFilter, setCatalogCommentFilter] = useState<CatalogCommentFilter>("all");
  const [catalogTagFilters, setCatalogTagFilters] = useState<readonly string[]>([]);
  const [catalogKnownTags, setCatalogKnownTags] = useState<readonly string[]>([]);
  const [catalogSort, setCatalogSort] = useState<CatalogSort>("newest");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<Error | null>(null);
  const [catalogRefreshState, setCatalogRefreshState] = useState<CatalogRefreshState>(
    "idle",
  );
  const [details, setDetails] = useState<ArtifactDetails | null>(null);
  const [versions, setVersions] = useState<readonly VersionListItem[]>([]);
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [actionNextCursor, setActionNextCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<Error | null>(null);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<Error | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<ArtifactVersion | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [catalogOpen, setCatalogOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(readInitialInspectorOpen);
  const [opening, setOpening] = useState(false);
  const [focusMode, setFocusMode] = useState(initialLocation.view === "focus");
  const [focusCommentsOpen, setFocusCommentsOpen] = useState(false);
  const [focusControlsCollapsed, setFocusControlsCollapsed] = useState(false);
  const [focusControlsHoverArmed, setFocusControlsHoverArmed] = useState(true);
  const [focusControlsInstant, setFocusControlsInstant] = useState(false);
  const [htmlAnnotateModeActive, setHtmlAnnotateModeActive] = useState(true);
  const [homeOpen, setHomeOpen] = useState(false);
  const focusCommentsButtonRef = useRef<HTMLButtonElement>(null);
  const focusControlsRestoreRef = useRef<HTMLButtonElement>(null);
  const previewPanelRef = useRef<HTMLElement>(null);
  const commentsInspectorRef = useRef<ReviewCommentsInspectorHandle>(null);
  const catalogRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogRequestGenerationRef = useRef(0);
  const catalogWidthApplyRef = useRef<(width: number) => void>(() => undefined);
  const inspectorWidthApplyRef = useRef<(width: number) => void>(() => undefined);
  const catalogResize = useReviewResizablePanel({
    apply: (width) => catalogWidthApplyRef.current(width),
    defaultWidth: catalogDefaultWidth,
    maxWidth: catalogMaximumWidth,
    minWidth: catalogMinimumWidth,
    onClick: () => setCatalogOpen(false),
    onSnapClose: () => setCatalogOpen(false),
    onSnapOpen: () => setCatalogOpen(true),
    side: "left",
    storageKey: "artifact-review-catalog-width",
  });
  const inspectorResize = useReviewResizablePanel({
    apply: (width) => inspectorWidthApplyRef.current(width),
    defaultWidth: inspectorDefaultWidth,
    maxWidth: inspectorMaximumWidth,
    minWidth: inspectorMinimumWidth,
    onClick: () => setInspectorOpen(false),
    onSnapClose: () => setInspectorOpen(false),
    onSnapOpen: () => setInspectorOpen(true),
    side: "right",
    storageKey: "artifact-review-inspector-width",
  });
  const catalogMotion = useReviewPanelMotion(catalogOpen, catalogResize.width);
  const inspectorMotion = useReviewPanelMotion(
    inspectorOpen,
    inspectorResize.width,
    inspectorGapPixels,
  );
  useEffect(() => {
    catalogWidthApplyRef.current = (width) => catalogMotion.width.set(width);
    inspectorWidthApplyRef.current = (width) => inspectorMotion.width.set(width);
  }, [catalogMotion.width, inspectorMotion.width]);
  const followCommentVersion = useCallback((versionId: string): void => {
    setDetailError(null);
    setSelectedVersionId(versionId);
    setSelectedPath(null);
  }, []);
  const comments = useReviewComments({
    artifactId: selectedArtifactId,
    onVersionChanged: followCommentVersion,
    projectId,
    versionId: selectedVersionId,
  });
  useEffect(() => {
    if (details === null || details.artifact.tags.length === 0) return;
    setCatalogKnownTags((current) => [
      ...new Set([...current, ...details.artifact.tags]),
    ].toSorted());
  }, [details]);
  const openCommentCount = comments.threads.filter(
    (thread) => thread.state === "open",
  ).length;

  // Browser agent tools (WebMCP): the ref hands the adapter live view state
  // each render; registration itself lives entirely in webmcp.tsx.
  const webmcpRef = useRef<WebmcpBindings>({
    getSnapshot: () => webmcpSnapshot(),
    openArtifact: () => undefined,
    reloadComments: () => Promise.resolve(),
  });
  const webmcpSnapshot = (): ReturnType<WebmcpBindings["getSnapshot"]> => ({
    artifact: details === null ? null : {
      currentVersionId: details.artifact.currentVersionId,
      id: details.artifact.id,
      name: details.artifact.name,
    },
    loading: detailLoading || comments.loading
      || (selectedArtifactId !== null && selectedVersion === null),
    projectId,
    projectName: projects.find((project) => project.id === projectId)?.name ?? null,
    replies: comments.repliesByThread,
    threads: comments.threads,
    version: selectedVersion === null ? null : {
      createdAt: selectedVersion.version.createdAt,
      id: selectedVersion.version.id,
    },
  });
  webmcpRef.current = {
    getSnapshot: webmcpSnapshot,
    openArtifact: (artifactId, versionId) => {
      setDetailError(null);
      setSelectedArtifactId(artifactId);
      setSelectedVersionId(versionId);
      setSelectedPath(null);
    },
    reloadComments: comments.reload,
  };
  useWebmcp(webmcpRef);

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const catalogItems = useMemo<ArtifactPage["artifacts"]>(() => {
    if (
      details === null
      || searchQuery !== ""
      || catalogCommentFilter !== "all"
      || catalogTagFilters.length > 0
      || items.some(({artifact}) => artifact.id === details.artifact.id)
    ) return items;
    return [{
      artifact: details.artifact,
      commentCount: comments.threads.length,
      links: details.links,
      versionCount: versions.length,
    }, ...items];
  }, [
    catalogCommentFilter,
    catalogTagFilters.length,
    comments.threads.length,
    details,
    items,
    searchQuery,
    versions.length,
  ]);
  const selectedIndex = catalogItems.findIndex(
    ({artifact}) => artifact.id === selectedArtifactId,
  );
  const selectedItem = selectedIndex < 0 ? null : catalogItems[selectedIndex] ?? null;
  const loadArtifacts = useCallback(async (
    cursor: string | null,
    replace: boolean,
  ): Promise<ArtifactListLoadResult> => {
    if (projectId === "") return "skipped";
    const requestGeneration = ++catalogRequestGenerationRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const page = await api.artifacts(projectId, cursor, catalogTagFilters, searchQuery, {
        comments: catalogCommentFilter,
        sort: catalogSort,
      });
      if (requestGeneration !== catalogRequestGenerationRef.current) return "skipped";
      setCatalogKnownTags((current) => {
        const next = new Set(current);
        for (const {artifact} of page.artifacts) {
          for (const tag of artifact.tags) next.add(tag);
        }
        return [...next].toSorted();
      });
      setItems((current) => replace ? page.artifacts : [...current, ...page.artifacts]);
      setNextCursor(page.nextCursor);
      if (replace) {
        setSelectedArtifactId((current) => {
          return current ?? page.artifacts[0]?.artifact.id ?? null;
        });
      }
      return "loaded";
    } catch (caught) {
      if (requestGeneration === catalogRequestGenerationRef.current) {
        setListError(
          caught instanceof Error ? caught : new Error("Artifact list failed."),
        );
      }
      return "failed";
    } finally {
      if (requestGeneration === catalogRequestGenerationRef.current) {
        setListLoading(false);
      }
    }
  }, [catalogCommentFilter, catalogSort, catalogTagFilters, projectId, searchQuery]);

  const refreshArtifacts = useCallback(async (): Promise<void> => {
    if (listLoading) return;
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
      catalogRefreshTimerRef.current = null;
    }
    setCatalogRefreshState("loading");
    const result = await loadArtifacts(null, true);
    if (result !== "loaded") {
      setCatalogRefreshState("idle");
      return;
    }
    setCatalogRefreshState("complete");
    catalogRefreshTimerRef.current = setTimeout(() => {
      catalogRefreshTimerRef.current = null;
      setCatalogRefreshState("idle");
    }, catalogRefreshConfirmationMilliseconds);
  }, [listLoading, loadArtifacts]);

  useEffect(() => () => {
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (catalogRefreshTimerRef.current !== null) {
      clearTimeout(catalogRefreshTimerRef.current);
      catalogRefreshTimerRef.current = null;
    }
    setCatalogRefreshState("idle");
    setItems([]);
    void loadArtifacts(null, true);
  }, [loadArtifacts]);

  useEffect(() => {
    if (selectedArtifactId === null || projectId === "") {
      setDetails(null);
      setVersions([]);
      setActions([]);
      setActionNextCursor(null);
      setComparison(null);
      setSelectedVersion(null);
      return undefined;
    }
    let current = true;
    setActions([]);
    setActionNextCursor(null);
    setComparison(null);
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const [loadedDetails, loadedVersions] = await Promise.all([
          api.artifact(projectId, selectedArtifactId),
          api.versions(projectId, selectedArtifactId),
        ]);
        if (!current) return;
        setDetails(loadedDetails);
        setVersions(loadedVersions);
        setSelectedVersionId((selected) => {
          return selected ?? loadedDetails.current.version.id;
        });
      } catch (caught) {
        if (!current) return;
        setDetails(null);
        setVersions([]);
        setSelectedVersion(null);
        setDetailError(
          caught instanceof Error ? caught : new Error("Artifact details failed."),
        );
      } finally {
        if (current) setDetailLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId, selectedArtifactId]);

  const refreshLinkedDetails = useCallback(async (): Promise<void> => {
    if (selectedArtifactId === null || projectId === "") return;
    try {
      setDetails(await api.artifact(projectId, selectedArtifactId));
    } catch {
      // Ambient freshness never replaces the last readable artifact state.
    }
  }, [projectId, selectedArtifactId]);

  useCommentPoll(
    refreshLinkedDetails,
    session.capabilities.linkedArtifacts && details?.sourceBinding !== undefined,
  );

  const loadActions = useCallback(async (cursor: string | null): Promise<void> => {
    if (selectedArtifactId === null || projectId === "") return;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const page = await api.actions(projectId, selectedArtifactId, cursor);
      setActions((current) => cursor === null ? page.actions : [...current, ...page.actions]);
      setActionNextCursor(page.nextCursor);
    } catch (caught) {
      setActivityError(caught instanceof Error ? caught : new Error("Activity loading failed."));
    } finally {
      setActivityLoading(false);
    }
  }, [projectId, selectedArtifactId]);

  useEffect(() => {
    if (inspectorTab === "activity" && actions.length === 0 && !activityLoading) {
      void loadActions(null);
    }
  }, [actions.length, activityLoading, inspectorTab, loadActions]);

  useEffect(() => {
    if (
      details === null
      || selectedArtifactId === null
      || selectedVersionId === null
    ) {
      setSelectedVersion(null);
      return undefined;
    }
    if (selectedVersionId === details.current.version.id) {
      setSelectedVersion(details.current);
      return undefined;
    }
    let current = true;
    setSelectedVersion(null);
    void (async () => {
      try {
        const loaded = await api.version(
          projectId,
          selectedArtifactId,
          selectedVersionId,
        );
        if (current) setSelectedVersion(loaded);
      } catch (caught) {
        if (!current) return;
        setDetailError(
          caught instanceof Error ? caught : new Error("Version loading failed."),
        );
      }
    })();
    return () => {
      current = false;
    };
  }, [details, projectId, selectedArtifactId, selectedVersionId]);

  useEffect(() => {
    const href = reviewHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: focusMode ? "focus" : null,
    });
    window.history.replaceState(null, "", href);
    window.sessionStorage.setItem("artifact-review-return-url", href);
  }, [focusMode, projectId, selectedArtifactId, selectedPath, selectedVersionId]);

  useEffect(() => {
    const restoreLocation = (): void => {
      const restored = readReviewLocation();
      if (restored.projectId !== null) {
        setCatalogKnownTags([]);
        setCatalogTagFilters([]);
        setProjectId(restored.projectId);
      }
      setSelectedArtifactId(restored.artifactId);
      setSelectedVersionId(restored.versionId);
      setSelectedPath(restored.path);
      setFocusMode(restored.view === "focus");
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  const openRawArtifact = async (): Promise<void> => {
    if (selectedArtifactId === null || selectedVersionId === null) return;
    const popup = window.open("about:blank", "_blank");
    setOpening(true);
    setDetailError(null);
    try {
      const issued = await api.contentSession(
        projectId,
        selectedArtifactId,
        selectedVersionId,
      );
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setDetailError(
        caught instanceof Error ? caught : new Error("Artifact opening failed."),
      );
    } finally {
      setOpening(false);
    }
  };

  const canComment = selectedProject?.archivedAt === null
    && (
      (
        session.principal.kind === "human"
        && session.principal.authorizedByPrincipalId === null
      )
      || session.principal.capabilities.includes("comment:write")
    );
  const canManageProjects = (
    session.principal.kind === "human"
    && session.principal.authorizedByPrincipalId === null
  ) || session.principal.capabilities.includes("project:manage");
  const canManageArtifacts = selectedProject?.archivedAt === null && (
    (
      session.principal.kind === "human"
      && session.principal.authorizedByPrincipalId === null
    )
    || session.principal.capabilities.includes("artifact:manage:any")
  );
  const canDeleteAnyComment = (
    session.principal.kind === "human"
    && session.principal.authorizedByPrincipalId === null
    && session.principal.membershipRole === "administrator"
  ) || session.principal.capabilities.includes("artifact:manage:any");
  const previewKind = reviewPreviewKind(selectedVersion, selectedPath);
  const download = reviewDownload(
    projectId,
    selectedArtifactId,
    selectedVersion,
  );
  const selectArtifact = useCallback((artifactId: string, versionId?: string): void => {
    setDetailError(null);
    setSelectedArtifactId(artifactId);
    setSelectedVersionId(versionId ?? null);
    setSelectedPath(null);
  }, []);
  const selectProject = (nextProjectId: string): void => {
    if (nextProjectId !== projectId) {
      setCatalogKnownTags([]);
      setCatalogTagFilters([]);
      setSelectedArtifactId(null);
      setSelectedVersionId(null);
      setSelectedPath(null);
    }
    setProjectId(nextProjectId);
  };
  const selectManifestPath = (path: string): void => {
    window.history.pushState(null, "", reviewHref({
      artifactId: selectedArtifactId,
      path,
      projectId,
      versionId: selectedVersionId,
      view: focusMode ? "focus" : null,
    }));
    setSelectedPath(path);
  };
  const changeTags = async (tags: readonly string[]): Promise<void> => {
    if (details === null) return;
    const changed = await api.changeTags(
      details.artifact.projectId,
      details.artifact.id,
      details.artifact.currentVersionId,
      tags,
      crypto.randomUUID(),
    );
    updateArtifact(changed.artifact);
  };
  const updateArtifact = (artifact: ArtifactDetails["artifact"]): void => {
    setCatalogKnownTags((current) => [...new Set([...current, ...artifact.tags])].toSorted());
    setDetails((current) => current?.artifact.id === artifact.id
      ? {...current, artifact}
      : current);
    setItems((current) => current.map((item) => item.artifact.id === artifact.id
      ? {...item, artifact}
      : item));
  };
  const makeVersionCurrent = async (
    versionId: string,
    expectedCurrentVersionId: string,
  ): Promise<boolean> => {
    if (details === null) return false;
    setDetailError(null);
    try {
      const restored = await api.restore(
        details.artifact.projectId,
        details.artifact.id,
        expectedCurrentVersionId,
        versionId,
        crypto.randomUUID(),
      );
      updateArtifact(restored.artifact);
      const [loadedDetails, loadedVersions] = await Promise.all([
        api.artifact(details.artifact.projectId, details.artifact.id),
        api.versions(details.artifact.projectId, details.artifact.id),
      ]);
      setDetails(loadedDetails);
      setVersions(loadedVersions);
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          const [loadedDetails, loadedVersions] = await Promise.all([
            api.artifact(details.artifact.projectId, details.artifact.id),
            api.versions(details.artifact.projectId, details.artifact.id),
          ]);
          setDetails(loadedDetails);
          setVersions(loadedVersions);
          updateArtifact(loadedDetails.artifact);
        } catch {
          // Keep the original conflict visible when refreshing pointer state fails.
        }
        setDetailError(new Error(
          "The current version changed before this action completed. Nothing was changed; the latest version state has been reloaded.",
        ));
        return false;
      }
      setDetailError(
        caught instanceof Error ? caught : new Error("The version could not be made current."),
      );
      return false;
    }
  };
  const compareVersions = async (fromVersionId: string, toVersionId: string): Promise<void> => {
    if (details === null || fromVersionId === toVersionId) return;
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      setComparison(await api.comparison(
        details.artifact.projectId,
        details.artifact.id,
        fromVersionId,
        toVersionId,
      ));
      setInspectorTab("compare");
    } catch (caught) {
      setComparisonError(caught instanceof Error ? caught : new Error("Version comparison failed."));
    } finally {
      setComparisonLoading(false);
    }
  };
  const captureLinkedArtifact = async (): Promise<void> => {
    if (details === null) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const captured = await api.captureArtifact(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      const [loadedDetails, loadedVersions] = await Promise.all([
        api.artifact(details.artifact.projectId, details.artifact.id),
        api.versions(details.artifact.projectId, details.artifact.id),
      ]);
      setDetails(loadedDetails);
      setVersions(loadedVersions);
      setSelectedVersionId(captured.version.id);
      updateArtifact(loadedDetails.artifact);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught : new Error("Linked artifact capture failed."));
    } finally {
      setDetailLoading(false);
    }
  };
  const openLinkedArtifact = async (): Promise<void> => {
    if (details === null) return;
    const popup = window.open("about:blank", "_blank");
    setDetailError(null);
    try {
      const issued = await api.liveSession(details.artifact.projectId, details.artifact.id);
      if (popup === null) window.location.assign(issued.bootstrapUrl);
      else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setDetailError(caught instanceof Error ? caught : new Error("Live artifact opening failed."));
    }
  };
  const tombstoneArtifact = async (): Promise<boolean> => {
    if (details === null) return false;
    setDetailError(null);
    try {
      await api.deleteArtifact(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      setItems((current) => current.filter(({artifact}) => artifact.id !== details.artifact.id));
      setSelectedArtifactId(null);
      setSelectedVersionId(null);
      setSelectedPath(null);
      setDetails(null);
      setVersions([]);
      void loadArtifacts(null, true);
      return true;
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught : new Error("Artifact deletion failed."));
      return false;
    }
  };
  const enterFocusMode = useCallback((): void => {
    window.history.pushState(null, "", reviewHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: "focus",
    }));
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    setFocusMode(true);
  }, [projectId, selectedArtifactId, selectedPath, selectedVersionId]);
  const exitFocusMode = useCallback((): void => {
    window.history.pushState(null, "", reviewHref({
      artifactId: selectedArtifactId,
      path: selectedPath,
      projectId,
      versionId: selectedVersionId,
      view: null,
    }));
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    setFocusMode(false);
  }, [projectId, selectedArtifactId, selectedPath, selectedVersionId]);
  useEffect(() => {
    const handleReviewShortcut = (event: KeyboardEvent): void => {
      if (homeOpen || reviewShortcutBlocked(event)) return;

      const key = event.key.toLowerCase();
      if (key === "escape") {
        if (focusCommentsOpen) {
          event.preventDefault();
          setFocusCommentsOpen(false);
        } else if (htmlAnnotateModeActive) {
          event.preventDefault();
          setHtmlAnnotateModeActive(false);
        } else if (focusMode) {
          event.preventDefault();
          exitFocusMode();
        }
        return;
      }

      if (key === "f" && selectedVersionId !== null) {
        event.preventDefault();
        if (focusMode) exitFocusMode();
        else enterFocusMode();
        return;
      }

      if (key === "]") {
        event.preventDefault();
        if (focusMode) setFocusCommentsOpen((current) => !current);
        else setInspectorOpen((current) => !current);
        return;
      }

      if (key === "[" && !focusMode) {
        event.preventDefault();
        setCatalogOpen((current) => !current);
        return;
      }

      const direction = key === "j" || key === "arrowdown"
        ? 1
        : key === "k" || key === "arrowup"
          ? -1
          : 0;
      if (direction === 0) return;

      event.preventDefault();
      const next = catalogItems[selectedIndex + direction];
      if (next !== undefined) {
        selectArtifact(next.artifact.id, next.artifact.currentVersionId);
      }
    };

    window.addEventListener("keydown", handleReviewShortcut);
    return () => window.removeEventListener("keydown", handleReviewShortcut);
  }, [
    catalogItems,
    enterFocusMode,
    exitFocusMode,
    focusCommentsOpen,
    focusMode,
    homeOpen,
    htmlAnnotateModeActive,
    selectArtifact,
    selectedIndex,
    selectedVersionId,
  ]);
  const hideFocusControls = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    previewPanelRef.current?.focus({preventScroll: true});
    setFocusControlsHoverArmed(event.detail === 0);
    setFocusControlsCollapsed(true);
    if (event.detail === 0) {
      window.requestAnimationFrame(() => {
        focusControlsRestoreRef.current?.focus({preventScroll: true});
      });
    }
  };
  const showFocusControls = (): void => {
    setFocusControlsHoverArmed(true);
    setFocusControlsCollapsed(false);
    window.requestAnimationFrame(() => focusCommentsButtonRef.current?.focus({preventScroll: true}));
  };
  useEffect(() => {
    if (!focusMode) return undefined;
    const revealFocusControls = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      const isShortcut = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && (event.code === "Backslash" || event.key === "\\");
      if (
        !isShortcut
        || event.defaultPrevented
        || event.isComposing
        || target?.closest('[role="dialog"], [data-slot="popover-content"]')
      ) {
        return;
      }
      event.preventDefault();
      setFocusControlsInstant(true);
      setFocusControlsCollapsed(false);
      window.requestAnimationFrame(() => {
        focusCommentsButtonRef.current?.focus({preventScroll: true});
        window.requestAnimationFrame(() => setFocusControlsInstant(false));
      });
    };
    window.addEventListener("keydown", revealFocusControls);
    return () => window.removeEventListener("keydown", revealFocusControls);
  }, [focusMode]);
  const returnHome = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }
    event.preventDefault();
    setHomeOpen(true);
  };

  return (
    <div
      className="as-app"
      data-catalog-open={catalogOpen}
      data-focus-mode={focusMode}
      data-html-annotate-mode={htmlAnnotateModeActive}
      data-inspector-open={inspectorOpen}
      data-panel-resizing={catalogResize.isDragging || inspectorResize.isDragging}
    >
      <a className="as-skip-link" href="#review-preview">Skip to artifact preview</a>

      <Dialog.Root onOpenChange={setHomeOpen} open={homeOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="as-home-overlay__backdrop" />
          <Dialog.Popup className="as-home-overlay">
            <Dialog.Title className="as-visually-hidden">Artifact Server home</Dialog.Title>
            <Dialog.Close
              aria-label="Close Artifact Server home"
              className="as-icon-button as-home-overlay__close"
              title="Close Artifact Server home"
            >
              <IconX aria-hidden="true" stroke={1.8} />
            </Dialog.Close>
            <div className="as-home-overlay__content">
            <img
              alt=""
              aria-hidden="true"
                className="as-home-overlay__animation"
              src={artifactServerAnimationUrl}
            />
              <nav aria-label="Artifact Server resources" className="as-home-resources">
                <a
                  className="as-home-resources__link"
                  href="https://github.com/plannotator/artifact-server"
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="as-home-resources__icon">
                    <IconBrandGithub aria-hidden="true" stroke={1.8} />
                  </span>
                  <span className="as-home-resources__identity">
                    <strong>GitHub</strong>
                    <span>Source and releases</span>
                  </span>
                  <IconExternalLink aria-hidden="true" stroke={1.8} />
                </a>
                <a
                  className="as-home-resources__link"
                  href="https://artifactserver.com/"
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="as-home-resources__icon">
                    <IconHome aria-hidden="true" stroke={1.8} />
                  </span>
                  <span className="as-home-resources__identity">
                    <strong>Homepage</strong>
                    <span>Product overview</span>
                  </span>
                  <IconExternalLink aria-hidden="true" stroke={1.8} />
                </a>
                <a
                  className="as-home-resources__link"
                  href="https://artifactserver.com/docs/"
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="as-home-resources__icon">
                    <IconBook aria-hidden="true" stroke={1.8} />
                  </span>
                  <span className="as-home-resources__identity">
                    <strong>Docs</strong>
                    <span>Install and deploy</span>
                  </span>
                  <IconExternalLink aria-hidden="true" stroke={1.8} />
                </a>
                {/* TODO(open-source-launch): publish the dedicated agent-connection guide at this canonical route. */}
                <a
                  className="as-home-resources__link"
                  href="https://artifactserver.com/docs/connect-agents/"
                  rel="noreferrer"
                  target="_blank"
                >
                  <span
                    aria-hidden="true"
                    className="as-home-resources__icon as-home-resources__icon--agents"
                  >
                    <AgentLogos />
                  </span>
                  <span className="as-home-resources__identity">
                    <strong>Connect agents</strong>
                    <span>MCP and client setup</span>
                  </span>
                  <IconExternalLink aria-hidden="true" stroke={1.8} />
                </a>
              </nav>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {!focusMode && catalogMotion.mounted ? (
        <div className="as-panel-assembly" data-side="left">
          <motion.div
            className="as-panel-clip as-catalog-clip"
            data-side="left"
            style={{width: catalogMotion.outerWidth}}
          >
            <motion.aside
              aria-label="Artifact catalog"
              className="as-catalog"
              style={{width: catalogMotion.width}}
            >
        <header className="as-pane-header as-catalog__header">
          <div className="as-catalog__context">
            <a
              aria-label="Artifact Server"
              className="as-catalog__brand"
              href="/review"
              onClick={returnHome}
              title="Artifact Server"
            >
              <ArtifactMark className="as-catalog__brand-mark" />
            </a>
            <ReviewProjectPicker
              canCreate={canManageProjects}
              onCreate={onCreateProject}
              onSelect={selectProject}
              projects={projects}
              selectedProjectId={projectId}
            />
          </div>
          <div className="as-catalog__header-actions">
            <IconButton
              label={theme === "moon" ? "Use light theme" : "Use dark theme"}
              onClick={onThemeChange}
            >
              {theme === "moon" ? <IconSun stroke={1.8} /> : <IconMoon stroke={1.8} />}
            </IconButton>
            <a
              aria-label="Open settings"
              className="as-icon-button"
              href={selectedProject === null
                ? "/review/settings/projects"
                : `/review/settings/projects/${encodeURIComponent(selectedProject.id)}`}
              title="Open settings"
            >
              <IconSettings stroke={1.8} />
            </a>
            <IconButton
              keyShortcuts="["
              label="Collapse artifact catalog"
              onClick={() => setCatalogOpen(false)}
              title="Collapse artifact catalog ([)"
            >
              <IconLayoutSidebar stroke={1.8} />
            </IconButton>
          </div>
        </header>

        <div className="as-catalog__tools">
          <div className="as-search-group">
            <label className="as-search">
              <span className="as-visually-hidden">Search artifacts</span>
              <IconSearch aria-hidden="true" stroke={1.8} />
              <input
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search artifacts…"
                type="search"
                value={query}
              />
              {query === "" ? null : (
                <button aria-label="Clear search" onClick={() => setQuery("")} type="button">
                  <IconX stroke={1.8} />
                </button>
              )}
            </label>
            <div className="as-catalog-query-controls">
              <CatalogFilters
                commentFilter={catalogCommentFilter}
                knownTags={catalogKnownTags}
                onCommentFilterChange={setCatalogCommentFilter}
                onTagFiltersChange={setCatalogTagFilters}
                tagFilters={catalogTagFilters}
              />
              <label>
                <span className="as-visually-hidden">Sort artifacts</span>
                <select
                  aria-label="Sort artifacts"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "comments" || value === "newest") setCatalogSort(value);
                  }}
                  value={catalogSort}
                >
                  <option value="newest">Newest first</option>
                  <option value="comments">Most comments</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="as-catalog__list">
          {listError === null ? null : (
            <InlineState description={listError.message} title="Catalog unavailable" tone="error" />
          )}
          {listLoading && items.length === 0 ? (
            <InlineState description="Reading this project." title="Loading artifacts" />
          ) : null}
          {!listLoading && listError === null && catalogItems.length === 0 ? (
            <InlineState
              description={
                query !== "" || catalogCommentFilter !== "all" || catalogTagFilters.length > 0
                  ? "Try clearing a filter or using a wider search."
                  : "Publish from the CLI to populate this project."
              }
              title={
                query !== "" || catalogCommentFilter !== "all" || catalogTagFilters.length > 0
                  ? "No matching artifacts"
                  : "No artifacts yet"
              }
            />
          ) : null}
          {catalogItems.map(({artifact, commentCount, versionCount}) => {
            const displayedCommentCount = artifact.id === selectedArtifactId && !comments.loading
              ? comments.threads.length
              : commentCount;
            return (
              <button
                aria-current={artifact.id === selectedArtifactId ? "true" : undefined}
                className="as-artifact-card"
                data-selected={artifact.id === selectedArtifactId}
                key={artifact.id}
                onClick={() => selectArtifact(artifact.id, artifact.currentVersionId)}
                type="button"
              >
                <span className="as-artifact-card__title-row">
                  <strong>{artifact.name}</strong>
                  <AccessPill access={artifact.accessSetting} />
                </span>
                <span className="as-artifact-card__meta">
                  <span className="as-artifact-card__history">
                    <time dateTime={artifact.createdAt}>{formatTimestamp(artifact.createdAt)}</time>
                    <span aria-hidden="true">·</span>
                    <span>{versionCount} version{versionCount === 1 ? "" : "s"}</span>
                  </span>
                  <span className="as-artifact-card__counts">
                    <span>
                      <IconMessage aria-hidden="true" stroke={1.8} />
                      {displayedCommentCount} comment{displayedCommentCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <footer className="as-app-footer as-catalog__footer">
          <button
            aria-busy={catalogRefreshState === "loading"}
            aria-label="Refresh artifacts published by agents, the CLI, or other sessions"
            className="as-catalog-refresh"
            data-state={catalogRefreshState}
            disabled={listLoading}
            onClick={() => void refreshArtifacts()}
            title="Refresh artifacts published by agents, the CLI, or other sessions"
            type="button"
          >
            {catalogRefreshState === "complete" ? <IconCheck aria-hidden="true" className="as-catalog-refresh__icon" stroke={1.8} /> : <IconRefresh aria-hidden="true" className="as-catalog-refresh__icon" stroke={1.8} />}
            <span>
              {catalogRefreshState === "loading"
                ? "Refreshing…"
                : catalogRefreshState === "complete"
                  ? "Refreshed"
                  : "Refresh"}
            </span>
          </button>
          <span aria-live="polite" className="as-visually-hidden">
            {catalogRefreshState === "loading"
              ? "Refreshing artifact catalog."
              : catalogRefreshState === "complete"
                ? "Artifact catalog refreshed."
                : ""}
          </span>
          <div className="as-catalog__footer-actions">
            {nextCursor === null ? null : (
              <button disabled={listLoading} onClick={() => void loadArtifacts(nextCursor, false)} type="button">
                {listLoading ? "Loading…" : "Load more"}
              </button>
            )}
            <ReviewKeyboardShortcuts />
          </div>
        </footer>
            </motion.aside>
          </motion.div>
          {catalogOpen ? (
            <ReviewPanelEdge
              label="Artifact catalog width"
              onCollapse={() => setCatalogOpen(false)}
              resize={catalogResize}
              side="left"
            />
          ) : null}
        </div>
      ) : null}

      <main className="as-workspace">
        <section
          className="as-preview-panel"
          id="review-preview"
          ref={previewPanelRef}
          tabIndex={-1}
        >
          {focusMode ? (
            <>
              <div
                className="as-focus-controls-dock"
                data-collapsed={focusControlsCollapsed}
                data-comments-open={focusCommentsOpen}
                data-hover-armed={focusControlsHoverArmed}
                data-instant={focusControlsInstant}
                onPointerLeave={() => setFocusControlsHoverArmed(true)}
              >
                <span aria-hidden="true" className="as-focus-controls__hover-zone" />
                <div
                  aria-hidden={focusControlsCollapsed}
                  aria-label="Artifact viewer controls"
                  className="as-focus-controls"
                  inert={focusControlsCollapsed}
                  role="toolbar"
                >
                  {previewKind === "html" && canComment ? (
                    <button
                      aria-pressed={htmlAnnotateModeActive}
                      className="as-button as-focus-controls__button"
                      data-active={htmlAnnotateModeActive}
                      onClick={() => setHtmlAnnotateModeActive((active) => !active)}
                      title={htmlAnnotateModeActive
                        ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
                        : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
                      type="button"
                    >
                      <IconPencil aria-hidden="true" stroke={1.8} />
                      {htmlAnnotateModeActive ? "Annotate mode" : "Interact mode"}
                    </button>
                  ) : null}
                  <button
                    aria-controls="review-focus-comments"
                    aria-expanded={focusCommentsOpen}
                    aria-keyshortcuts="]"
                    className="as-button as-focus-controls__button"
                    data-active={focusCommentsOpen}
                    onClick={() => setFocusCommentsOpen((current) => !current)}
                    ref={focusCommentsButtonRef}
                    title="Toggle comments (])"
                    type="button"
                  >
                    <IconMessage aria-hidden="true" stroke={1.8} />
                    Comments
                    <span className="as-focus-controls__count">{openCommentCount}</span>
                  </button>
                  <ReviewShareControl
                    details={details}
                    key={`focus-share-${details?.artifact.id ?? "empty"}`}
                    onArtifactChanged={updateArtifact}
                    selectedPath={selectedPath}
                    selectedVersion={selectedVersion}
                    triggerVariant="ghost"
                  />
                  <ReviewDownloadControl
                    className="as-button as-focus-controls__button"
                    download={download}
                  />
                  <button
                    aria-keyshortcuts="F"
                    className="as-button as-focus-controls__button"
                    onClick={exitFocusMode}
                    title="Exit full screen (F)"
                    type="button"
                  >
                    <IconArrowsMinimize aria-hidden="true" stroke={1.8} />
                    Exit full screen
                  </button>
                  <button
                    aria-label="Hide viewer controls"
                    className="as-icon-button as-focus-controls__collapse"
                    onClick={hideFocusControls}
                    title="Hide viewer controls"
                    type="button"
                  >
                    <IconChevronRight aria-hidden="true" stroke={1.8} />
                  </button>
                </div>
                <button
                  aria-hidden={!focusControlsCollapsed}
                  aria-keyshortcuts="Meta+\\ Control+\\"
                  aria-label="Show viewer controls"
                  className="as-focus-controls__restore"
                  onClick={showFocusControls}
                  ref={focusControlsRestoreRef}
                  tabIndex={focusControlsCollapsed ? 0 : -1}
                  title="Show viewer controls (Command/Control + \\)"
                  type="button"
                >
                  <IconChevronLeft aria-hidden="true" stroke={1.8} />
                </button>
              </div>
              <aside
                aria-hidden={!focusCommentsOpen}
                aria-labelledby="review-focus-comments-title"
                className="as-focus-comments"
                data-open={focusCommentsOpen}
                id="review-focus-comments"
                inert={!focusCommentsOpen}
              >
                <header className="as-focus-comments__header">
                  <div>
                    <IconMessage aria-hidden="true" stroke={1.8} />
                    <h2 id="review-focus-comments-title">Comments</h2>
                    <span>{openCommentCount}</span>
                  </div>
                  <IconButton
                    keyShortcuts="] Escape"
                    label="Close comments"
                    onClick={() => setFocusCommentsOpen(false)}
                    title="Close comments (] or Esc)"
                  >
                    <IconX stroke={1.8} />
                  </IconButton>
                </header>
                <div className="as-focus-comments__body">
                  <ReviewCommentsInspector
                    canComment={canComment}
                    canDeleteAny={canDeleteAnyComment}
                    principalId={session.principal.id}
                    ref={commentsInspectorRef}
                    session={comments}
                    versionId={selectedVersionId}
                  />
                </div>
              </aside>
            </>
          ) : null}
          <header className="as-pane-header as-preview-header">
            <div className="as-preview-header__identity">
              {!catalogOpen ? (
                <IconButton
                  keyShortcuts="["
                  label="Open artifact catalog"
                  onClick={() => setCatalogOpen(true)}
                  title="Open artifact catalog ([)"
                >
                  <IconLayoutSidebar stroke={1.8} />
                </IconButton>
              ) : null}
              <h1>{details?.artifact.name ?? selectedItem?.artifact.name ?? "Artifact Server"}</h1>
            </div>
            <div className="as-preview-header__actions">
              {previewKind === "html" && canComment ? (
                <IconButton
                  active={htmlAnnotateModeActive}
                  label={htmlAnnotateModeActive
                    ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
                    : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
                  onClick={() => setHtmlAnnotateModeActive((active) => !active)}
                >
                  <IconPencil stroke={1.8} />
                </IconButton>
              ) : null}
              <button
                aria-label={opening ? "Opening raw artifact" : "Open raw artifact"}
                className="as-button as-button--secondary as-preview-header__raw"
                disabled={selectedVersionId === null || opening}
                onClick={() => void openRawArtifact()}
                type="button"
              >
                <IconExternalLink aria-hidden="true" stroke={1.8} />
                <span className="as-button__label">
                  {opening ? "Opening…" : "Open raw artifact"}
                </span>
              </button>
              <ReviewShareControl
                details={details}
                key={`header-share-${details?.artifact.id ?? "empty"}`}
                onArtifactChanged={updateArtifact}
                selectedPath={selectedPath}
                selectedVersion={selectedVersion}
                triggerVariant="secondary"
              />
              <ReviewDownloadControl
                className="as-button as-button--secondary"
                download={download}
              />
              <button
                aria-label="Full screen"
                aria-keyshortcuts="F"
                className="as-button as-button--primary"
                disabled={selectedVersionId === null}
                onClick={enterFocusMode}
                title="Full screen (F)"
                type="button"
              >
                <IconMaximize aria-hidden="true" stroke={1.8} />
                <span className="as-button__label">Full screen</span>
              </button>
              {!inspectorOpen ? (
                <IconButton
                  keyShortcuts="]"
                  label="Open inspector"
                  onClick={() => setInspectorOpen(true)}
                  title="Open inspector (])"
                >
                  <IconLayoutSidebarRight stroke={1.8} />
                </IconButton>
              ) : null}
            </div>
          </header>

          <div className="as-preview-panel__body" data-preview-kind={previewKind}>
            {detailError === null ? null : (
              <div className="as-preview-error" role="alert">{detailError.message}</div>
            )}
            {selectedArtifactId === null ? (
              <PreviewWelcome />
            ) : detailLoading && details === null ? (
              <PreviewWelcome description="Loading artifact metadata and immutable history." title="Reading artifact" />
            ) : detailError !== null && selectedVersion === null ? (
              <PreviewWelcome
                description="The project, artifact, or version named by this Review URL is unavailable."
                title="Review target unavailable"
              />
            ) : (
              <ReviewPreview
                annotateModeActive={htmlAnnotateModeActive}
                annotations={comments.annotations}
                artifactId={selectedArtifactId}
                artifactName={details?.artifact.name ?? selectedItem?.artifact.name ?? "Artifact"}
                isLight={theme === "dawn"}
                onOpenRawArtifact={() => void openRawArtifact()}
                onAnnotateModeChange={setHtmlAnnotateModeActive}
                onSelectAnnotation={(threadId) => {
                  comments.selectThread(threadId);
                  if (threadId !== null) {
                    setInspectorTab("comments");
                    if (focusMode) {
                      setFocusCommentsOpen(true);
                    } else {
                      setInspectorOpen(true);
                    }
                  }
                }}
                onSubmitAnnotation={async (body, anchor, path) => {
                  const saved = await comments.submit(body, anchor, path);
                  if (!saved && selectedArtifactId !== null && selectedVersionId !== null) {
                    // The in-frame composer discards its text on failure; keep
                    // it as this version's new-thread draft instead.
                    writeDraft({
                      artifactId: selectedArtifactId,
                      principalId: session.principal.id,
                      threadId: null,
                      versionId: selectedVersionId,
                    }, body);
                  }
                  if (saved) {
                    setInspectorTab("comments");
                    if (!focusMode) {
                      setInspectorOpen(true);
                    }
                  }
                  return saved;
                }}
                onUnanchoredChange={comments.updateUnanchored}
                opening={opening}
                projectId={projectId}
                readOnly={!canComment}
                selectedThreadId={comments.selectedThreadId}
                selectedPath={selectedPath}
                version={selectedVersion}
              />
            )}
          </div>

          <footer className="as-app-footer as-preview-footer">
            <div className="as-preview-footer__nav">
              <IconButton
                disabled={selectedIndex <= 0}
                keyShortcuts="K ArrowUp"
                label="Previous artifact"
                onClick={() => {
                  const previous = catalogItems[selectedIndex - 1];
                  if (previous !== undefined) {
                    selectArtifact(previous.artifact.id, previous.artifact.currentVersionId);
                  }
                }}
                title="Previous artifact (K or ↑)"
              >
                <IconChevronLeft stroke={1.8} />
              </IconButton>
              <span className="as-tabular">
                {selectedIndex < 0 ? "0" : selectedIndex + 1} / {catalogItems.length}
              </span>
              <IconButton
                disabled={selectedIndex < 0 || selectedIndex >= catalogItems.length - 1}
                keyShortcuts="J ArrowDown"
                label="Next artifact"
                onClick={() => {
                  const next = catalogItems[selectedIndex + 1];
                  if (next !== undefined) {
                    selectArtifact(next.artifact.id, next.artifact.currentVersionId);
                  }
                }}
                title="Next artifact (J or ↓)"
              >
                <IconChevronRight stroke={1.8} />
              </IconButton>
            </div>
            <div className="as-preview-footer__status">
              <span className="as-preview-footer__metadata">
                {selectedVersion === null
                  ? "No version selected"
                  : `${selectedVersion.manifest.entries.length} file${selectedVersion.manifest.entries.length === 1 ? "" : "s"} · ${selectedVersion.version.routingMode.toUpperCase()}`}
              </span>
              <button
                className="as-button as-preview-footer__reload"
                disabled={comments.loading || selectedVersion === null}
                onClick={() => void (
                  commentsInspectorRef.current?.reload() ?? comments.reload()
                )}
                type="button"
              >
                <IconRefresh aria-hidden="true" stroke={1.8} />
                {comments.loading ? "Loading…" : "Reload"}
              </button>
            </div>
          </footer>
        </section>

        {!focusMode && inspectorMotion.mounted ? (
          <div className="as-panel-assembly" data-side="right">
            {inspectorOpen ? (
              <ReviewPanelEdge
                label="Artifact inspector width"
                onCollapse={() => setInspectorOpen(false)}
                resize={inspectorResize}
                side="right"
              />
            ) : null}
            <motion.div
              className="as-panel-clip as-inspector-clip"
              data-side="right"
              style={{width: inspectorMotion.outerWidth}}
            >
              <motion.aside
                aria-label="Artifact inspector"
                className="as-inspector"
                style={{width: inspectorMotion.width}}
              >
          <header className="as-pane-header as-inspector__header">
            <div aria-label="Artifact inspector" className="as-tabs" role="tablist">
              <InspectorTabButton active={inspectorTab === "comments"} count={openCommentCount} label="Comments" onClick={() => setInspectorTab("comments")} tab="comments" />
              <InspectorTabButton active={inspectorTab === "details"} label="Details" onClick={() => setInspectorTab("details")} tab="details" />
              <InspectorTabButton active={inspectorTab === "files"} count={selectedVersion?.manifest.entries.length ?? 0} label="Files" onClick={() => setInspectorTab("files")} tab="files" />
              <InspectorTabButton active={inspectorTab === "versions"} count={versions.length} label="Versions" onClick={() => setInspectorTab("versions")} tab="versions" />
              <InspectorTabButton active={inspectorTab === "activity"} label="Activity" onClick={() => setInspectorTab("activity")} tab="activity" />
              {comparison === null ? null : (
                <InspectorTabButton active={inspectorTab === "compare"} label="Compare" onClick={() => setInspectorTab("compare")} tab="compare" />
              )}
            </div>
            <IconButton
              keyShortcuts="]"
              label="Close inspector"
              onClick={() => setInspectorOpen(false)}
              title="Close inspector (])"
            >
              <IconX stroke={1.8} />
            </IconButton>
          </header>
          <div
            aria-labelledby={`review-inspector-tab-${inspectorTab}`}
            className="as-inspector__body"
            id="review-inspector-panel"
            role="tabpanel"
          >
            {details === null || selectedVersion === null ? (
              <InlineState description="Select an artifact to inspect its immutable record." title="Nothing selected" />
            ) : inspectorTab === "details" ? (
              <DetailsInspector
                canManage={canManageArtifacts}
                details={details}
                linkedArtifacts={session.capabilities.linkedArtifacts}
                onCapture={captureLinkedArtifact}
                onOpenLive={openLinkedArtifact}
                onTagsChange={changeTags}
                onTombstone={tombstoneArtifact}
                version={selectedVersion}
              />
            ) : inspectorTab === "comments" ? (
              <ReviewCommentsInspector
                canComment={canComment}
                canDeleteAny={canDeleteAnyComment}
                principalId={session.principal.id}
                ref={commentsInspectorRef}
                session={comments}
                versionId={selectedVersionId}
              />
            ) : inspectorTab === "files" ? (
              <FilesInspector
                onSelect={selectManifestPath}
                selectedPath={selectedPath ?? selectedVersion.manifest.entryPath}
                version={selectedVersion}
              />
            ) : inspectorTab === "versions" ? (
              <VersionsInspector
                canManage={canManageArtifacts}
                comparisonLoading={comparisonLoading}
                currentVersionId={details.artifact.currentVersionId}
                onCompare={compareVersions}
                onMakeCurrent={makeVersionCurrent}
                onSelect={(versionId) => {
                  setDetailError(null);
                  setSelectedVersionId(versionId);
                  setSelectedPath(null);
                }}
                selectedVersionId={selectedVersionId}
                versions={versions}
              />
            ) : inspectorTab === "activity" ? (
              <ActivityInspector
                actions={actions}
                error={activityError}
                loading={activityLoading}
                nextCursor={actionNextCursor}
                onLoadMore={() => void loadActions(actionNextCursor)}
              />
            ) : (
              <ComparisonInspector comparison={comparison} error={comparisonError} />
            )}
          </div>
              </motion.aside>
            </motion.div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function readInitialInspectorOpen(): boolean {
  return window.matchMedia("(min-width: 1181px)").matches;
}

