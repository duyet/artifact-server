import type {Ref} from "react";
import {IconX} from "@tabler/icons-react";

import type {Session} from "@/api/client";
import {Badge} from "@/components/ui/badge";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import {ActivityInspector, ComparisonInspector} from "../inspectors/activity-inspector.tsx";
import {DetailsInspector} from "../inspectors/details-inspector.tsx";
import {FilesInspector} from "../inspectors/files-inspector.tsx";
import type {InspectorTab} from "../inspectors/inspector-layout.tsx";
import {VersionsInspector} from "../inspectors/versions-inspector.tsx";
import {
  ReviewCommentsInspector,
  type ReviewCommentSession,
  type ReviewCommentsInspectorHandle,
} from "../review-comments.tsx";
import type {ReviewPermissions} from "../review-permissions.ts";
import {IconButton, PreviewWelcome} from "../review-primitives.tsx";
import type {ArtifactViewer} from "./use-artifact-viewer.ts";

const inspectorTabs = (
  ["comments", "details", "files", "versions", "activity", "compare"] as const satisfies readonly InspectorTab[]
);

const tabLabels = {
  activity: "Activity",
  comments: "Comments",
  compare: "Compare",
  details: "Details",
  files: "Files",
  versions: "Versions",
} as const satisfies Record<InspectorTab, string>;

/** The right-hand inspector: comments, details, files, history, activity, diff. */
export function ArtifactInspector({
  comments,
  commentsRef,
  onClose,
  onCompared,
  onSelectFile,
  onSelectVersion,
  onTabChange,
  onTombstone,
  openCommentCount,
  permissions,
  selectedPath,
  selectedVersionId,
  session,
  tab,
  viewer,
}: {
  readonly comments: ReviewCommentSession;
  readonly commentsRef: Ref<ReviewCommentsInspectorHandle>;
  readonly onClose: () => void;
  readonly onCompared: () => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSelectVersion: (versionId: string) => void;
  readonly onTabChange: (tab: InspectorTab) => void;
  readonly onTombstone: () => Promise<boolean>;
  readonly openCommentCount: number;
  readonly permissions: ReviewPermissions;
  readonly selectedPath: string | null;
  readonly selectedVersionId: string | null;
  readonly session: Session;
  readonly tab: InspectorTab;
  readonly viewer: ArtifactViewer;
}) {
  const {details, selectedVersion} = viewer;
  const visibleTabs = inspectorTabs.filter((value) => value !== "compare" || viewer.comparison !== null);

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col gap-0"
      onValueChange={(value: InspectorTab) => onTabChange(value)}
      value={tab}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b pr-1.5 pl-2">
        <TabsList aria-label="Artifact inspector" className="min-w-0 flex-1 justify-start gap-0 overflow-x-auto [scrollbar-width:none]" variant="line">
          {visibleTabs.map((value) => (
            <TabsTrigger className="flex-none px-1 text-xs" key={value} value={value}>
              {tabLabels[value]}
              {value === "comments" && openCommentCount > 0 ? (
                <Badge className="h-4 min-w-4 px-1 text-[0.625rem]" variant="secondary">{openCommentCount}</Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <IconButton keyShortcuts="]" label="Close inspector" onClick={onClose} shortcut="]">
          <IconX />
        </IconButton>
      </header>
      <TabsContent className="as-inspector__body min-h-0 flex-1 overflow-y-auto p-3" value={tab}>
        {details === null || selectedVersion === null ? (
          <PreviewWelcome description="Select an artifact to inspect its immutable record." title="Nothing selected" />
        ) : tab === "details" ? (
          <DetailsInspector
            canManage={permissions.canManageArtifacts}
            details={details}
            onTagsChange={viewer.changeTags}
            onTombstone={onTombstone}
            version={selectedVersion}
            viewerPrincipalId={session.principal.id}
          />
        ) : tab === "comments" ? (
          <ReviewCommentsInspector
            canComment={permissions.canComment}
            canDeleteAny={permissions.canDeleteAnyComment}
            principalId={session.principal.id}
            ref={commentsRef}
            session={comments}
            versionId={selectedVersionId}
          />
        ) : tab === "files" ? (
          <FilesInspector
            onSelect={onSelectFile}
            selectedPath={selectedPath ?? selectedVersion.manifest.entryPath}
            version={selectedVersion}
          />
        ) : tab === "versions" ? (
          <VersionsInspector
            canManage={permissions.canManageArtifacts}
            comparisonLoading={viewer.comparisonLoading}
            currentVersionId={details.artifact.currentVersionId}
            onCompare={async (from, to) => {
              if (await viewer.compareVersions(from, to)) onCompared();
            }}
            onMakeCurrent={viewer.makeVersionCurrent}
            onSelect={onSelectVersion}
            selectedVersionId={selectedVersionId}
            versions={viewer.versions}
          />
        ) : tab === "activity" ? (
          <ActivityInspector
            actions={viewer.actions}
            error={viewer.activityError}
            loading={viewer.activityLoading}
            nextCursor={viewer.actionNextCursor}
            onLoadMore={() => void viewer.loadActions(viewer.actionNextCursor)}
          />
        ) : (
          <ComparisonInspector comparison={viewer.comparison} error={viewer.comparisonError} />
        )}
      </TabsContent>
    </Tabs>
  );
}
