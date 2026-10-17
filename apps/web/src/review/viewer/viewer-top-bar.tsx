import type {ReactNode} from "react";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconHistory,
  IconLayoutSidebarRight,
  IconMaximize,
  IconPencil,
  IconShare,
  IconTrash,
  IconCursorText,
} from "@tabler/icons-react";
import {toast} from "sonner";

import type {ArtifactOwner, ArtifactVersion} from "@/api/client";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Separator} from "@/components/ui/separator";
import {SidebarTrigger} from "@/components/ui/sidebar";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import type {VersionListItem} from "../inspectors/versions-inspector.tsx";
import {OwnerAvatar, principalLabel} from "../owner-avatar.tsx";
import {ReviewDownloadControl, type ReviewDownload} from "../review-download.tsx";
import {IconButton} from "../review-primitives.tsx";

/** The artifact menu's actions; absent ones are hidden or disabled. */
export interface ViewerMenuActions {
  readonly onDelete: (() => void) | null;
  readonly onDuplicate: (() => void) | null;
  readonly onEditFile: (() => void) | null;
  readonly onRename: (() => void) | null;
  readonly onShare: () => void;
  readonly onShowHistory: () => void;
}

/**
 * The viewer's single compact bar: where you are, which version, and what you
 * can do with it. Modeled on Claude's artifact viewer.
 */
export function ViewerTopBar({
  annotate,
  currentVersionId,
  download,
  fullScreenDisabled,
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
  const copyLink = async (): Promise<void> => {
    if (selectedVersion === null) return;
    try {
      await navigator.clipboard.writeText(selectedVersion.links.review);
      toast.success("Review link copied");
    } catch {
      toast.error("The link could not be copied.");
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <SidebarTrigger aria-keyshortcuts="[" />
      <Separator className="mx-1 data-vertical:h-4 data-vertical:self-center" orientation="vertical" />
      <div className="flex min-w-0 items-center">
        <h1 className="truncate px-1.5 text-sm font-medium">{name}</h1>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button aria-label="Artifact actions" size="icon-xs" variant="ghost" />}>
            <IconChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
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
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {download === null ? null : (
                <DropdownMenuItem render={<a download href={download.href} />}>
                  <IconDownload />
                  Download
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled={selectedVersion === null} onClick={() => void copyLink()}>
                <IconExternalLink />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={menu.onShare}>
                <IconShare />
                Share
              </DropdownMenuItem>
              <DropdownMenuItem onClick={menu.onShowHistory}>
                <IconHistory />
                Version history
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
      <VersionNavigator
        currentVersionId={currentVersionId}
        onSelect={onSelectVersion}
        selectedVersionId={selectedVersionId}
        versions={versions}
      />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {owner === null ? null : (
          <Tooltip>
            <TooltipTrigger render={<span className="mr-1 flex" />}>
              <OwnerAvatar identity={owner} />
            </TooltipTrigger>
            <TooltipContent>Created by {principalLabel(owner, viewerPrincipalId)}</TooltipContent>
          </Tooltip>
        )}
        {annotate === null ? null : (
          <IconButton
            active={annotate.active}
            label={annotate.active
              ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
              : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
            onClick={annotate.toggle}
          >
            <IconPencil />
          </IconButton>
        )}
        <IconButton
          disabled={selectedVersionId === null || opening}
          label={opening ? "Opening raw artifact" : "Open raw artifact"}
          onClick={onOpenRaw}
        >
          <IconExternalLink />
        </IconButton>
        <ReviewDownloadControl download={download} />
        <IconButton
          disabled={fullScreenDisabled}
          keyShortcuts="F"
          label="Full screen"
          onClick={onFullScreen}
          shortcut="F"
        >
          <IconMaximize />
        </IconButton>
        {inspectorOpen ? null : (
          <IconButton keyShortcuts="]" label="Open inspector" onClick={onOpenInspector} shortcut="]">
            <IconLayoutSidebarRight />
          </IconButton>
        )}
        {share}
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
