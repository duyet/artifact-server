import {
  IconDots,
  IconExternalLink,
  IconLayoutNavbarCollapse,
  IconLayoutSidebarLeftExpand,
  IconLink,
  IconMaximize,
} from "@tabler/icons-react";
import {toast} from "sonner";

import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {IconButton} from "@/review/review-primitives";
import {ArtifactInfoPopover} from "@/review/viewer/artifact-info-popover";
import {ViewerLogo} from "@/review/viewer/viewer-logo";
import type {ReadableArtifact} from "./use-readable-artifact.js";

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied");
  } catch {
    toast.error("The link could not be copied.");
  }
}

/**
 * The 40px bar above a page opened at its readable URL. It is application
 * markup outside the sandboxed frame, so the page never reaches it.
 */
export function ReadableBar({
  artifact,
  onFullScreen,
  onHide,
  rawUrl,
}: {
  readonly artifact: ReadableArtifact;
  readonly onFullScreen: () => void;
  readonly onHide: () => void;
  /** The same URL with `?raw=1`: the page alone, with no bar. */
  readonly rawUrl: string;
}) {
  const reviewUrl = artifact.reviewUrl;

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2" aria-label="Artifact viewer">
      <div className="flex min-w-0 items-center gap-1.5">
        <ViewerLogo />
        <h1 className="truncate text-sm font-medium">{artifact.name ?? "Artifact"}</h1>
        <ArtifactInfoPopover
          owner={artifact.owner}
          state={artifact.info}
          viewerPrincipalId={artifact.viewerPrincipalId}
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <IconButton label="Hide bar" onClick={onHide}>
          <IconLayoutNavbarCollapse />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button aria-label="Artifact actions" size="icon-sm" variant="ghost" />}>
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void copyLink()}>
                <IconLink />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.location.assign(rawUrl)}>
                <IconExternalLink />
                Open raw
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onFullScreen}>
                <IconMaximize />
                Full screen
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {reviewUrl === null ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => window.location.assign(reviewUrl)}>
                    <IconLayoutSidebarLeftExpand />
                    Open in Review
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
