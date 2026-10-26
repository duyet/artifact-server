import {
  IconDots,
  IconExternalLink,
  IconLayoutNavbarCollapse,
  IconLayoutSidebarLeftExpand,
  IconLink,
  IconLogin,
  IconMaximize,
} from "@tabler/icons-react";
import {toast} from "sonner";

import {AccountMenu, AccountMenuItems} from "@/account/account-menu";
import {type SignInContext, signInHref} from "@/account/sign-in-context";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {useIsMobile} from "@/hooks/use-mobile";
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
  signIn,
}: {
  readonly artifact: ReadableArtifact;
  /**
   * The frame has left the page the bar names, to a URL the viewer cannot
   * read, so nothing that describes that page is shown.
   */
  readonly navigatedAway: boolean;
  readonly onFullScreen: () => void;
  readonly onHide: () => void;
  /** The URL the tab opened, which loads the named artifact again. */
  readonly openedUrl: string;
  /** The opened URL with `?raw=1`: the named artifact's page alone, with no bar. */
  readonly rawUrl: string;
  /** The server's sign-in route and Help page, or null until it answers. */
  readonly signIn: SignInContext | null;
}) {
  const reviewUrl = navigatedAway ? null : artifact.reviewUrl;
  // A phone has no room beside the menu, so the account moves into it.
  const accountInMenu = useIsMobile();
  const reader = artifact.reader;
  // Sign-in returns to this artifact by ID once its info names one.
  const signInUrl = signInHref(
    signIn,
    artifact.artifactId === null ? {kind: "home"} : {artifactId: artifact.artifactId, kind: "artifact"},
  );
  const helpUrl = signIn?.helpUrl ?? null;

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2" aria-label="Artifact viewer">
      <div className="flex min-w-0 items-center gap-1.5">
        <ViewerLogo />
        <h1 className="truncate text-sm font-medium">
          {navigatedAway ? "Navigated away" : artifact.name ?? "Artifact"}
        </h1>
        {navigatedAway ? (
          <ButtonLink className="min-w-0 max-w-56" href={openedUrl} size="xs" variant="outline">
            <span className="truncate">Open this page</span>
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
                <DropdownMenuItem onClick={() => void copyLink()}>
                  <IconLink />
                  Copy link
                </DropdownMenuItem>
              )}
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
            {accountInMenu && reader.kind === "member" ? (
              <>
                <DropdownMenuSeparator />
                <AccountMenuItems account={reader.account} afterSignOut={openedUrl} helpUrl={helpUrl} />
              </>
            ) : null}
            {accountInMenu && reader.kind === "anonymous" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem render={<a href={signInUrl} />}>
                    <IconLogin />
                    Sign in
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {!accountInMenu && reader.kind === "member" ? (
          <AccountMenu account={reader.account} afterSignOut={openedUrl} helpUrl={helpUrl} size="sm" />
        ) : null}
        {!accountInMenu && reader.kind === "anonymous" ? (
          <ButtonLink href={signInUrl} size="xs" variant="outline">Sign in</ButtonLink>
        ) : null}
      </div>
    </header>
  );
}
