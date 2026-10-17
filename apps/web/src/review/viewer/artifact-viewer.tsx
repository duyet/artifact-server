import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {IconChevronLeft, IconChevronRight, IconRefresh} from "@tabler/icons-react";
import {motion} from "motion/react";

import {writeDraft} from "@/components/comments/comment-drafts";
import type {Artifact, Project, Session} from "@/api/client";
import {
  DuplicateArtifactDialog,
  EditArtifactFileDialog,
  isEditableMediaType,
  RenameArtifactDialog,
  type ArtifactActionResult,
} from "@/artifact-actions";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {useSidebar} from "@/components/ui/sidebar";
import type {CatalogItem} from "../catalog/use-artifact-catalog.ts";
import {DeleteArtifactDialog} from "../inspectors/details-inspector.tsx";
import type {InspectorTab} from "../inspectors/inspector-layout.tsx";
import {
  ReviewCommentsInspector,
  useReviewComments,
  type ReviewCommentsInspectorHandle,
} from "../review-comments.tsx";
import {ReviewDownloadControl, reviewDownload} from "../review-download.tsx";
import {reviewPreviewKind, type ReviewLocation} from "../review-location.ts";
import type {ReviewPermissions} from "../review-permissions.ts";
import {ReviewPreview} from "../review-preview.tsx";
import {IconButton, PreviewWelcome} from "../review-primitives.tsx";
import {ReviewPanelEdge} from "../review-panel-edge.tsx";
import {ReviewShareControl} from "../review-share.tsx";
import {reviewShortcutBlocked} from "../review-shortcuts.tsx";
import type {NavigationMode} from "../use-review-navigation.ts";
import {useReviewPanelMotion} from "../use-review-panel-motion.ts";
import {useReviewResizablePanel} from "../use-review-resizable-panel.ts";
import type {WebmcpBindings} from "../webmcp.tsx";
import {ArtifactInspector} from "./artifact-inspector.tsx";
import {FocusComments, FocusDock} from "./focus-mode.tsx";
import {useArtifactViewer} from "./use-artifact-viewer.ts";
import {ViewerTopBar} from "./viewer-top-bar.tsx";

const inspectorDefaultWidth = 368;
const inspectorMinimumWidth = 240;
const inspectorMaximumWidth = 480;
const inspectorGapPixels = 0;

type ArtifactAction = "delete" | "duplicate" | "edit" | "rename";

function readInitialInspectorOpen(): boolean {
  return window.matchMedia("(min-width: 1181px)").matches;
}

/** One artifact version: preview, inspector, version navigation, and full screen. */
export function ArtifactViewer({
  artifactId,
  focus,
  go,
  navItems,
  onArtifactChanged,
  onArtifactDeleted,
  onCatalogStale,
  path,
  permissions,
  project,
  projectId,
  session,
  theme,
  versionId,
  webmcpRef,
}: {
  readonly artifactId: string;
  readonly focus: boolean;
  readonly go: (patch: Partial<ReviewLocation>, mode: NavigationMode) => void;
  readonly navItems: readonly CatalogItem[];
  readonly onArtifactChanged: (artifact: Artifact) => void;
  readonly onArtifactDeleted: (artifactId: string) => void;
  /** Another artifact appeared (a duplicate), so the list is out of date. */
  readonly onCatalogStale: () => void;
  readonly path: string | null;
  readonly permissions: ReviewPermissions;
  readonly project: Project | null;
  readonly projectId: string;
  readonly session: Session;
  readonly theme: "dawn" | "moon";
  readonly versionId: string | null;
  readonly webmcpRef: RefObject<WebmcpBindings>;
}) {
  const {setOpen: setSidebarOpen} = useSidebar();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [inspectorOpen, setInspectorOpen] = useState(readInitialInspectorOpen);
  const [shareOpen, setShareOpen] = useState(false);
  const [action, setAction] = useState<ArtifactAction | null>(null);
  const [focusCommentsOpen, setFocusCommentsOpen] = useState(false);
  const [focusControlsCollapsed, setFocusControlsCollapsed] = useState(false);
  const [focusControlsHoverArmed, setFocusControlsHoverArmed] = useState(true);
  const [focusControlsInstant, setFocusControlsInstant] = useState(false);
  const [annotateActive, setAnnotateActive] = useState(true);
  const focusCommentsButtonRef = useRef<HTMLButtonElement>(null);
  const focusControlsRestoreRef = useRef<HTMLButtonElement>(null);
  const previewPanelRef = useRef<HTMLElement>(null);
  const commentsInspectorRef = useRef<ReviewCommentsInspectorHandle>(null);
  const inspectorWidthApplyRef = useRef<(width: number) => void>(() => undefined);
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
  const inspectorMotion = useReviewPanelMotion(inspectorOpen, inspectorResize.width, inspectorGapPixels);
  useEffect(() => {
    inspectorWidthApplyRef.current = (width) => inspectorMotion.width.set(width);
  }, [inspectorMotion.width]);

  const selectVersion = useCallback((nextVersionId: string): void => {
    go({path: null, versionId: nextVersionId}, "replace");
  }, [go]);
  const viewer = useArtifactViewer({
    artifactId,
    linkedArtifacts: session.capabilities.linkedArtifacts,
    onArtifactChanged,
    onVersionResolved: selectVersion,
    projectId,
    versionId,
  });
  const comments = useReviewComments({
    artifactId,
    onVersionChanged: selectVersion,
    projectId,
    versionId,
  });
  const {details, selectedVersion} = viewer;
  const openCommentCount = comments.threads.filter((thread) => thread.state === "open").length;

  useEffect(() => {
    if (details !== null) onArtifactChanged(details.artifact);
  }, [details, onArtifactChanged]);

  // Full screen owns the whole window, so the sidebar steps aside for it.
  useEffect(() => {
    if (focus) setSidebarOpen(false);
  }, [focus, setSidebarOpen]);

  const {actions, activityLoading, loadActions} = viewer;
  useEffect(() => {
    if (inspectorTab === "activity" && actions.length === 0 && !activityLoading) {
      void loadActions(null);
    }
  }, [actions.length, activityLoading, inspectorTab, loadActions]);

  webmcpRef.current = {
    getSnapshot: () => ({
      artifact: details === null ? null : {
        currentVersionId: details.artifact.currentVersionId,
        id: details.artifact.id,
        name: details.artifact.name,
      },
      loading: viewer.loading || comments.loading || selectedVersion === null,
      projectId,
      projectName: project?.name ?? null,
      replies: comments.repliesByThread,
      threads: comments.threads,
      version: selectedVersion === null ? null : {
        createdAt: selectedVersion.version.createdAt,
        id: selectedVersion.version.id,
      },
    }),
    openArtifact: (nextArtifactId, nextVersionId) => {
      go({artifactId: nextArtifactId, path: null, versionId: nextVersionId}, "push");
    },
    reloadComments: comments.reload,
  };

  const navIndex = navItems.findIndex(({artifact}) => artifact.id === artifactId);
  const openNeighbor = useCallback((direction: -1 | 1): void => {
    const next = navItems[navIndex + direction];
    if (next !== undefined) {
      go({artifactId: next.artifact.id, path: null, versionId: next.artifact.currentVersionId}, "replace");
    }
  }, [go, navIndex, navItems]);

  const enterFocusMode = useCallback((): void => {
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    go({view: "focus"}, "push");
  }, [go]);
  const exitFocusMode = useCallback((): void => {
    setFocusCommentsOpen(false);
    setFocusControlsCollapsed(false);
    setSidebarOpen(true);
    go({view: null}, "push");
  }, [go, setSidebarOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (reviewShortcutBlocked(event)) return;
      const key = event.key.toLowerCase();
      if (key === "escape") {
        if (focusCommentsOpen) {
          event.preventDefault();
          setFocusCommentsOpen(false);
        } else if (annotateActive) {
          event.preventDefault();
          setAnnotateActive(false);
        } else if (focus) {
          event.preventDefault();
          exitFocusMode();
        }
        return;
      }
      if (key === "f" && versionId !== null) {
        event.preventDefault();
        if (focus) exitFocusMode();
        else enterFocusMode();
        return;
      }
      if (key === "]") {
        event.preventDefault();
        if (focus) setFocusCommentsOpen((current) => !current);
        else setInspectorOpen((current) => !current);
        return;
      }
      const direction = key === "j" || key === "arrowdown" ? 1 : key === "k" || key === "arrowup" ? -1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      openNeighbor(direction);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [annotateActive, enterFocusMode, exitFocusMode, focus, focusCommentsOpen, openNeighbor, versionId]);

  useEffect(() => {
    if (!focus) return undefined;
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
  }, [focus]);

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

  const previewKind = reviewPreviewKind(selectedVersion, path);
  const download = reviewDownload(projectId, artifactId, selectedVersion);
  const name = details?.artifact.name
    ?? navItems.find(({artifact}) => artifact.id === artifactId)?.artifact.name
    ?? "Artifact";
  const annotate = previewKind === "html" && permissions.canComment
    ? {active: annotateActive, toggle: () => setAnnotateActive((active) => !active)}
    : null;
  const editable = selectedVersion?.manifest.entries.some((entry) => isEditableMediaType(entry.mediaType)) ?? false;
  const tombstone = async (): Promise<boolean> => {
    const removed = await viewer.tombstoneArtifact();
    if (removed) onArtifactDeleted(artifactId);
    return removed;
  };
  const canAct = permissions.canManageArtifacts && details !== null && selectedVersion !== null;
  const closeAction = (open: boolean): void => {
    if (!open) setAction(null);
  };
  const onPublished = (result: ArtifactActionResult): void => {
    setAction(null);
    if (result.artifact.id === artifactId) {
      void viewer.reload().then(() => go({path, versionId: result.version.id}, "replace"));
    } else {
      onCatalogStale();
      go({artifactId: result.artifact.id, path: null, versionId: result.version.id, view: null}, "push");
    }
  };
  const share = (variant: "ghost" | "outline") => (
    <ReviewShareControl
      details={details}
      key={`share-${details?.artifact.id ?? "empty"}`}
      onArtifactChanged={viewer.updateArtifact}
      onOpenChange={setShareOpen}
      open={shareOpen}
      selectedPath={path}
      selectedVersion={selectedVersion}
      triggerVariant={variant}
    />
  );

  return (
    <div className="flex h-svh min-h-0 flex-col" data-focus-mode={focus}>
      <a className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2" href="#review-preview">
        Skip to artifact preview
      </a>
      {focus ? null : (
        <ViewerTopBar
          annotate={annotate}
          currentVersionId={details?.artifact.currentVersionId ?? null}
          download={download}
          fullScreenDisabled={versionId === null}
          inspectorOpen={inspectorOpen}
          menu={{
            onDelete: canAct ? () => setAction("delete") : null,
            onDuplicate: canAct ? () => setAction("duplicate") : null,
            onEditFile: canAct && editable ? () => setAction("edit") : null,
            onRename: canAct ? () => setAction("rename") : null,
            onShare: () => setShareOpen(true),
            onShowHistory: () => {
              setInspectorTab("versions");
              setInspectorOpen(true);
            },
          }}
          name={name}
          onFullScreen={enterFocusMode}
          onOpenRaw={() => void viewer.openRawArtifact()}
          onSelectVersion={selectVersion}
          onOpenInspector={() => setInspectorOpen(true)}
          opening={viewer.opening}
          owner={details?.artifact.owner ?? null}
          selectedVersion={selectedVersion}
          selectedVersionId={versionId}
          share={share("outline")}
          versions={viewer.versions}
          viewerPrincipalId={session.principal.id}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <section
          className="as-preview-panel relative flex min-w-0 flex-1 flex-col outline-none"
          id="review-preview"
          ref={previewPanelRef}
          tabIndex={-1}
        >
          {focus ? (
            <>
              <FocusDock
                annotate={annotate}
                collapsed={focusControlsCollapsed}
                commentsButtonRef={focusCommentsButtonRef}
                commentsOpen={focusCommentsOpen}
                download={<ReviewDownloadControl download={download} variant="secondary" />}
                hoverArmed={focusControlsHoverArmed}
                instant={focusControlsInstant}
                onCollapse={hideFocusControls}
                onExit={exitFocusMode}
                onPointerLeave={() => setFocusControlsHoverArmed(true)}
                onRestore={showFocusControls}
                onToggleComments={() => setFocusCommentsOpen((open) => !open)}
                openCommentCount={openCommentCount}
                restoreRef={focusControlsRestoreRef}
                share={share("outline")}
              />
              <FocusComments
                onClose={() => setFocusCommentsOpen(false)}
                open={focusCommentsOpen}
                openCommentCount={openCommentCount}
              >
                <ReviewCommentsInspector
                  canComment={permissions.canComment}
                  canDeleteAny={permissions.canDeleteAnyComment}
                  principalId={session.principal.id}
                  ref={commentsInspectorRef}
                  session={comments}
                  versionId={versionId}
                />
              </FocusComments>
            </>
          ) : null}
          {viewer.error === null ? null : (
            <Alert className="m-2 w-auto" variant="destructive">
              <AlertDescription>{viewer.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="as-preview-panel__body min-h-0 flex-1" data-preview-kind={previewKind}>
            {viewer.loading && details === null ? (
              <PreviewWelcome description="Loading artifact metadata and immutable history." title="Reading artifact" />
            ) : viewer.error !== null && selectedVersion === null ? (
              <PreviewWelcome
                description="The project, artifact, or version named by this Review URL is unavailable."
                title="Review target unavailable"
              />
            ) : (
              <ReviewPreview
                annotateModeActive={annotateActive}
                annotations={comments.annotations}
                artifactId={artifactId}
                artifactName={name}
                isLight={theme === "dawn"}
                onAnnotateModeChange={setAnnotateActive}
                onOpenRawArtifact={() => void viewer.openRawArtifact()}
                onSelectAnnotation={(threadId) => {
                  comments.selectThread(threadId);
                  if (threadId !== null) {
                    setInspectorTab("comments");
                    if (focus) setFocusCommentsOpen(true);
                    else setInspectorOpen(true);
                  }
                }}
                onSubmitAnnotation={async (body, anchor, annotationPath) => {
                  const saved = await comments.submit(body, anchor, annotationPath);
                  if (!saved && versionId !== null) {
                    // The in-frame composer discards its text on failure; keep
                    // it as this version's new-thread draft instead.
                    writeDraft({
                      artifactId,
                      principalId: session.principal.id,
                      threadId: null,
                      versionId,
                    }, body);
                  }
                  if (saved) {
                    setInspectorTab("comments");
                    if (!focus) setInspectorOpen(true);
                  }
                  return saved;
                }}
                onUnanchoredChange={comments.updateUnanchored}
                opening={viewer.opening}
                projectId={projectId}
                readOnly={!permissions.canComment}
                selectedPath={path}
                selectedThreadId={comments.selectedThreadId}
                version={selectedVersion}
              />
            )}
          </div>
          {focus ? null : (
            <footer className="flex h-9 shrink-0 items-center justify-between gap-2 border-t px-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <IconButton
                  disabled={navIndex <= 0}
                  keyShortcuts="K ArrowUp"
                  label="Previous artifact"
                  onClick={() => openNeighbor(-1)}
                  shortcut="K"
                >
                  <IconChevronLeft />
                </IconButton>
                <span className="tabular-nums">
                  {navIndex < 0 ? "0" : navIndex + 1} / {navItems.length}
                </span>
                <IconButton
                  disabled={navIndex < 0 || navIndex >= navItems.length - 1}
                  keyShortcuts="J ArrowDown"
                  label="Next artifact"
                  onClick={() => openNeighbor(1)}
                  shortcut="J"
                >
                  <IconChevronRight />
                </IconButton>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">
                  {selectedVersion === null
                    ? "No version selected"
                    : `${selectedVersion.manifest.entries.length} file${selectedVersion.manifest.entries.length === 1 ? "" : "s"} · ${selectedVersion.version.routingMode.toUpperCase()}`}
                </span>
                <Button
                  disabled={comments.loading || selectedVersion === null}
                  onClick={() => void (commentsInspectorRef.current?.reload() ?? comments.reload())}
                  size="xs"
                  variant="ghost"
                >
                  <IconRefresh data-icon="inline-start" />
                  {comments.loading ? "Loading…" : "Reload"}
                </Button>
              </div>
            </footer>
          )}
        </section>

        {!focus && inspectorMotion.mounted ? (
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
              className="as-panel-clip h-full overflow-hidden border-l"
              data-side="right"
              style={{width: inspectorMotion.outerWidth}}
            >
              <motion.aside
                aria-label="Artifact inspector"
                className="h-full bg-background"
                style={{width: inspectorMotion.width}}
              >
                <ArtifactInspector
                  comments={comments}
                  commentsRef={commentsInspectorRef}
                  onClose={() => setInspectorOpen(false)}
                  onCompared={() => setInspectorTab("compare")}
                  onSelectFile={(nextPath) => go({path: nextPath}, "push")}
                  onSelectVersion={selectVersion}
                  onTabChange={setInspectorTab}
                  onTombstone={tombstone}
                  openCommentCount={openCommentCount}
                  permissions={permissions}
                  selectedPath={path}
                  selectedVersionId={versionId}
                  session={session}
                  tab={inspectorTab}
                  viewer={viewer}
                />
              </motion.aside>
            </motion.div>
          </div>
        ) : null}
      </div>

      {details === null || selectedVersion === null ? null : (
        <>
          <RenameArtifactDialog
            artifact={details.artifact}
            onDone={(result) => {
              setAction(null);
              void viewer.reload();
              onArtifactChanged({...details.artifact, name: result.artifact.name});
            }}
            onOpenChange={closeAction}
            open={action === "rename"}
            projectId={projectId}
            version={selectedVersion}
          />
          <EditArtifactFileDialog
            artifact={details.artifact}
            onDone={onPublished}
            onOpenChange={closeAction}
            open={action === "edit"}
            projectId={projectId}
            version={selectedVersion}
          />
          <DuplicateArtifactDialog
            artifact={details.artifact}
            onDone={onPublished}
            onOpenChange={closeAction}
            open={action === "duplicate"}
            projectId={projectId}
            version={selectedVersion}
          />
          <DeleteArtifactDialog
            artifact={details.artifact}
            onConfirm={tombstone}
            onOpenChange={closeAction}
            open={action === "delete"}
          />
        </>
      )}
    </div>
  );
}
