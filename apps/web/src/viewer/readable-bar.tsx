import {
  IconDots,
  IconExternalLink,
  IconLayoutNavbarCollapse,
  IconLayoutSidebarLeftExpand,
  IconLink,
  IconMaximize,
} from "@tabler/icons-react";
import {toast} from "sonner";

import {Button, ButtonLink} from "@/components/ui/button";
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
  navigatedAway,
  onFullScreen,
  onHide,
  openedUrl,
  rawUrl,
}: {
  readonly artifact: ReadableArtifact;
  /**
   * The frame has left the page the bar names, to a URL the viewer cannot
   * read, so nothing that describes that page is shown.
   */
  readonly navigatedAway: boolean;
  readonly onFullScreen: () => void;
  readonly onHide: () => void;
  /** The URL the tab opened, which loads the named page again. */
  readonly openedUrl: string;
  /** The same URL with `?raw=1`: the page alone, with no bar. */
  readonly rawUrl: string;
}) {
  const reviewUrl = navigatedAway ? null : artifact.reviewUrl;

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2" aria-label="Artifact viewer">
      <div className="flex min-w-0 items-center gap-1.5">
        <ViewerLogo />
        <h1 className="truncate text-sm font-medium">
          {navigatedAway ? "Navigated away" : artifact.name ?? "Artifact"}
        </h1>
        {navigatedAway ? (
          <ButtonLink className="min-w-0 max-w-56" href={openedUrl} size="xs" variant="outline">
            <span className="truncate">Back to {artifact.name ?? "the artifact"}</span>
          </ButtonLink>
        ) : (
          <ArtifactInfoPopover
            owner={artifact.owner}
            state={artifact.info}
            viewerPrincipalId={artifact.viewerPrincipalId}
          />
        )}
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
              {navigatedAway ? null : (
                <>
                  <DropdownMenuItem onClick={() => void copyLink()}>
                    <IconLink />
                    Copy link
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.location.assign(rawUrl)}>
                    <IconExternalLink />
                    Open raw
                  </DropdownMenuItem>
                </>
              )}
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
