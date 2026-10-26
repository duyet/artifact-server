import {type ReactNode, useSyncExternalStore} from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconCursorText,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconHistory,
  IconLayoutSidebarRight,
  IconLink,
  IconMaximize,
  IconPencil,
  IconShare,
  IconTrash,
} from "@tabler/icons-react";

import type {ArtifactOwner, ArtifactVersion} from "@/api/client";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {copyText} from "@/lib/copy-text";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Separator} from "@/components/ui/separator";
import {SidebarTrigger} from "@/components/ui/sidebar";
import type {VersionListItem} from "../inspectors/versions-inspector.tsx";
import type {ReviewDownload} from "../review-download.tsx";
import {IconButton} from "../review-primitives.tsx";
import {ArtifactInfoPopover} from "./artifact-info-popover.tsx";
import type {ArtifactInfoState} from "./use-artifact-info.ts";
import {ViewerLogo} from "./viewer-logo.tsx";

/** The artifact menu's actions; absent ones are hidden or disabled. */
export interface ViewerMenuActions {
  readonly onDelete: (() => void) | null;
  readonly onDuplicate: (() => void) | null;
  readonly onEditFile: (() => void) | null;
  readonly onRename: (() => void) | null;
  readonly onShare: () => void;
  readonly onShowVersions: () => void;
}

/** Tailwind's `sm` breakpoint, where the bar has room for its view buttons. */
const narrowViewport = "(width < 40rem)";

function subscribeNarrowViewport(onChange: () => void): () => void {
  const query = window.matchMedia(narrowViewport);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isNarrowViewport(): boolean {
  return window.matchMedia(narrowViewport).matches;
}

/**
 * The viewer's 40px bar: the installation logo, the artifact's name and info,
 * which version, and what you can do with it. It is application markup
 * outside the sandboxed review frame, so artifact code never reaches it.
 */
export function ViewerTopBar({
  annotate,
  currentVersionId,
  download,
  fullScreenDisabled,
  info,
  inspectorOpen,
  menu,
  name,
  onFullScreen,
  onOpenRaw,
  onSelectVersion,
  onOpenInspector,
  opening,
  owner,
  selectedVersion,
  selectedVersionId,
  share,
  versions,
  viewerPrincipalId,
}: {
  readonly annotate: {readonly active: boolean; readonly toggle: () => void} | null;
  readonly currentVersionId: string | null;
  readonly download: ReviewDownload | null;
  readonly fullScreenDisabled: boolean;
  readonly info: ArtifactInfoState;
  readonly inspectorOpen: boolean;
  readonly menu: ViewerMenuActions;
  readonly name: string;
  readonly onFullScreen: () => void;
  readonly onOpenRaw: () => void;
  readonly onSelectVersion: (versionId: string) => void;
  readonly onOpenInspector: () => void;
  readonly opening: boolean;
  readonly owner: ArtifactOwner | null;
  readonly selectedVersion: ArtifactVersion | null;
  readonly selectedVersionId: string | null;
  readonly share: ReactNode;
  readonly versions: readonly VersionListItem[];
  readonly viewerPrincipalId: string;
}) {
  // Below `sm` the view buttons leave the bar for the menu. Rendering those
  // items only then keeps the menu's keyboard order free of hidden entries.
  const narrow = useSyncExternalStore(subscribeNarrowViewport, isNarrowViewport);
  const copyLink = async (): Promise<void> => {
    if (selectedVersion === null) return;
    await copyText(selectedVersion.links.review, "Review link copied");
  };

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <SidebarTrigger aria-keyshortcuts="[" />
      <Separator className="mx-1 data-vertical:h-4 data-vertical:self-center" orientation="vertical" />
      <div className="flex min-w-0 items-center gap-1.5">
        <ViewerLogo />
        <h1 className="truncate text-sm font-medium">{name}</h1>
        <ArtifactInfoPopover owner={owner} state={info} viewerPrincipalId={viewerPrincipalId} />
      </div>
      <VersionNavigator
        currentVersionId={currentVersionId}
        onSelect={onSelectVersion}
        selectedVersionId={selectedVersionId}
        versions={versions}
      />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {annotate === null ? null : (
          <span className="hidden sm:flex">
            <IconButton
              active={annotate.active}
              label={annotate.active
                ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
                : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
              onClick={annotate.toggle}
            >
              <IconPencil />
            </IconButton>
          </span>
        )}
        <span className="hidden sm:flex">
          <IconButton
            disabled={fullScreenDisabled}
            keyShortcuts="F"
            label="Full screen"
            onClick={onFullScreen}
            shortcut="F"
          >
            <IconMaximize />
          </IconButton>
        </span>
        {inspectorOpen ? null : (
          <span className="hidden sm:flex">
            <IconButton keyShortcuts="]" label="Open inspector" onClick={onOpenInspector} shortcut="]">
              <IconLayoutSidebarRight />
            </IconButton>
          </span>
        )}
        {share}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button aria-label="Artifact actions" size="icon-sm" variant="ghost" />}>
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {narrow ? (
              <>
                <DropdownMenuGroup>
                  {annotate === null ? null : (
                    <DropdownMenuCheckboxItem checked={annotate.active} onCheckedChange={annotate.toggle}>
                      <IconPencil />
                      Annotate
                    </DropdownMenuCheckboxItem>
                  )}
                  <DropdownMenuItem disabled={fullScreenDisabled} onClick={onFullScreen}>
                    <IconMaximize />
                    Full screen
                  </DropdownMenuItem>
                  {inspectorOpen ? null : (
                    <DropdownMenuItem onClick={onOpenInspector}>
                      <IconLayoutSidebarRight />
                      Open inspector
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={selectedVersion === null} onClick={() => void copyLink()}>
                <IconLink />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={menu.onShowVersions}>
                <IconHistory />
                Versions
              </DropdownMenuItem>
              <DropdownMenuItem disabled={selectedVersionId === null || opening} onClick={onOpenRaw}>
                <IconExternalLink />
                Open raw
              </DropdownMenuItem>
              {download === null ? null : (
                <DropdownMenuItem render={<a download href={download.href} title={download.title} />}>
                  <IconDownload />
                  Download
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={menu.onRename === null} onClick={() => menu.onRename?.()}>
                <IconCursorText />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={menu.onEditFile === null} onClick={() => menu.onEditFile?.()}>
                <IconFileText />
                Edit file
              </DropdownMenuItem>
              <DropdownMenuItem disabled={menu.onDuplicate === null} onClick={() => menu.onDuplicate?.()}>
                <IconCopy />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={menu.onShare}>
                <IconShare />
                Share
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {menu.onDelete === null ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={menu.onDelete} variant="destructive">
                    <IconTrash />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Step through versions or jump to one; the current version is badged. */
function VersionNavigator({
  currentVersionId,
  onSelect,
  selectedVersionId,
  versions,
}: {
  readonly currentVersionId: string | null;
  readonly onSelect: (versionId: string) => void;
  readonly selectedVersionId: string | null;
  readonly versions: readonly VersionListItem[];
}) {
  if (versions.length === 0 || selectedVersionId === null) return null;
  const ordered = versions.toSorted((left, right) => left.version.number - right.version.number);
  const index = ordered.findIndex(({version}) => version.id === selectedVersionId);
  const older = index > 0 ? ordered[index - 1] : undefined;
  const newer = index >= 0 ? ordered[index + 1] : undefined;
  const items = ordered.toReversed().map(({version}) => ({
    label: `Version ${version.number}`,
    value: version.id,
  }));
  const selectedNumber = ordered[index]?.version.number;
  return (
    <div className="ml-2 hidden items-center gap-1 md:flex">
      <IconButton
        disabled={older === undefined}
        label="Previous version"
        onClick={() => {
          if (older !== undefined) onSelect(older.version.id);
        }}
      >
        <IconChevronLeft />
      </IconButton>
      <Select
        items={items}
        onValueChange={(value) => {
          if (value !== null) onSelect(value);
        }}
        value={selectedVersionId}
      >
        <SelectTrigger aria-label="Version" size="sm">
          <SelectValue>
            {() => selectedNumber === undefined ? "Version" : `v${selectedNumber} of ${ordered.length}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
                {item.value === currentVersionId ? <Badge variant="secondary">Current</Badge> : null}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <IconButton
        disabled={newer === undefined}
        label="Next version"
        onClick={() => {
          if (newer !== undefined) onSelect(newer.version.id);
        }}
      >
        <IconChevronRight />
      </IconButton>
      {selectedVersionId === currentVersionId ? <Badge variant="secondary">Current</Badge> : null}
    </div>
  );
}
