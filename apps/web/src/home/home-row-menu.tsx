import {
  IconCopy,
  IconDots,
  IconExternalLink,
  IconHistory,
  IconPencil,
} from "@tabler/icons-react";
import {useState} from "react";
import {toast} from "sonner";
// Sonner injects its styles with a <style> element, which the application
// CSP blocks; the same rules load from this stylesheet instead.
import "sonner/dist/styles.css";

import {api, type ArtifactDetails} from "@/api/client";
import {RenameArtifactDialog} from "@/artifact-actions";
import {newActionKey} from "@/artifact-actions/action-key";
import {describeActionError} from "@/artifact-actions/describe-error";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {Toaster} from "@/components/ui/sonner";
import {readThemePreference} from "@/lib/theme";
import {reviewHref} from "@/review/review-location";

import {
  treeVisibilities,
  unlistedTag,
  visibilityLabels,
  visibilityWrites,
  type PublicArtifactTreeEntry,
  type TreeManageHandle,
  type TreeVisibility,
} from "./home-tree.js";

/**
 * The `⋯` menu on a row the viewer may change. The server sends a manage
 * handle only when it would accept the change, so this menu never offers a
 * write the visibility API would refuse. This module loads only for a
 * signed-in reader, so an anonymous one never downloads the API client.
 */
export function ArtifactRowMenu({
  artifact,
  handle,
  onChanged,
}: {
  readonly artifact: PublicArtifactTreeEntry;
  readonly handle: TreeManageHandle;
  readonly onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState<ArtifactDetails | null>(null);
  // A private artifact about to gain a link waits for the reader to confirm.
  const [exposing, setExposing] = useState<TreeVisibility | null>(null);
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? describeActionError(error) : "The change failed.");
    } finally {
      setPending(false);
    }
  };
  const changeVisibility = (target: TreeVisibility) => run(async () => {
    try {
      // The tags write replaces every tag, so it starts from the artifact as
      // the server holds it now, not as the tree last read it.
      const {artifact: current} = await api.artifact(handle.projectId, handle.artifactId);
      const writes = visibilityWrites({
        tags: current.tags,
        visibility: current.accessSetting === "account_required"
          ? "private"
          : current.tags.includes(unlistedTag) ? "unlisted" : "public",
      }, target);
      if (writes.tags !== null) {
        await api.changeTags(
          handle.projectId,
          handle.artifactId,
          current.currentVersionId,
          writes.tags,
          newActionKey("visibility"),
        );
      }
      const changed = writes.accessSetting === null
        ? null
        : await api.changeAccess(
          handle.projectId,
          handle.artifactId,
          current.currentVersionId,
          writes.accessSetting,
          newActionKey("visibility"),
        );
      toast.success(`${artifact.name} is now ${visibilityLabels[target].toLowerCase()}.`, {
        description: changed?.warning ?? undefined,
      });
    } finally {
      // A failed second write can leave the first in place, so the tree
      // reads the server either way.
      onChanged();
    }
  });
  const chooseVisibility = (target: TreeVisibility) => {
    if (target === artifact.visibility) return;
    if (artifact.visibility === "private") setExposing(target);
    else void changeVisibility(target);
  };
  // The rename dialog guards its write with the artifact as the server last
  // read it, so it opens on a fresh read rather than on the tree's copy.
  const openRename = () => run(async () => {
    setRenaming(await api.artifact(handle.projectId, handle.artifactId));
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              aria-label={`Actions for ${artifact.name}`}
              className="shrink-0"
              disabled={pending}
              size="icon-sm"
              variant="ghost"
            />
          )}
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem render={<a href={artifact.url} />}>
              <IconExternalLink />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void run(async () => {
                await navigator.clipboard.writeText(artifact.url);
                toast.success("Link copied.");
              })}
            >
              <IconCopy />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem
              render={(
                <a
                  href={reviewHref({
                    artifactId: handle.artifactId,
                    path: null,
                    projectId: handle.projectId,
                    versionId: null,
                    view: null,
                  })}
                />
              )}
            >
              <IconHistory />
              Versions
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openRename()}>
              <IconPencil />
              Rename…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Visibility</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                const target = treeVisibilities.find((visibility) => visibility === value);
                if (target !== undefined) chooseVisibility(target);
              }}
              value={artifact.visibility}
            >
              {treeVisibilities.map((visibility) => (
                // The menu closes on a choice, so a second choice cannot race
                // the first before the tree reads the result.
                <DropdownMenuRadioItem
                  closeOnClick
                  disabled={pending}
                  key={visibility}
                  value={visibility}
                >
                  {visibilityLabels[visibility]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setExposing(null);
        }}
        open={exposing !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share {artifact.name} by link?</AlertDialogTitle>
            <AlertDialogDescription>
              {exposing === "unlisted"
                ? "Anyone with its link can open it. It stays off the public home page."
                : "Anyone with its link can open it, and it appears on the public home page."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (exposing !== null) void changeVisibility(exposing);
                setExposing(null);
              }}
            >
              Make {exposing === null ? "" : visibilityLabels[exposing].toLowerCase()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {renaming === null ? null : (
        <RenameArtifactDialog
          artifact={renaming.artifact}
          onDone={() => {
            onChanged();
          }}
          onOpenChange={(open) => {
            if (!open) setRenaming(null);
          }}
          open
          projectId={handle.projectId}
          version={renaming.current}
        />
      )}
    </>
  );
}

/** The toasts the row menu raises, mounted once for a signed-in reader. */
export function RowMenuToaster() {
  return <Toaster position="bottom-right" theme={readThemePreference()} />;
}
