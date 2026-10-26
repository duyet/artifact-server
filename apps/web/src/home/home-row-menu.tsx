import {
  IconCopy,
  IconDots,
  IconExternalLink,
  IconHistory,
  IconPencil,
} from "@tabler/icons-react";
import {useState} from "react";
import {toast} from "sonner";

import {api, type ArtifactDetails} from "@/api/client";
import {RenameArtifactDialog} from "@/artifact-actions";
import {newActionKey} from "@/artifact-actions/action-key";
import {describeActionError} from "@/artifact-actions/describe-error";
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
import {reviewHref} from "@/review/review-location";

import {
  visibilityWrites,
  type PublicArtifactTreeEntry,
  type TreeManageHandle,
  type TreeVisibility,
} from "./home-tree.js";

/** The words each visibility shows in the row menu and on a row's badge. */
export const visibilityLabels = {
  private: "Private",
  public: "Public",
  unlisted: "Unlisted",
} as const satisfies Record<TreeVisibility, string>;

/**
 * The `⋯` menu on a row the viewer may change. The server sends a manage
 * handle only when it would accept the change, so this menu never offers a
 * write the visibility API would refuse.
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
    const writes = visibilityWrites({tags: handle.tags, visibility: artifact.visibility}, target);
    if (writes.tags !== null) {
      await api.changeTags(
        handle.projectId,
        handle.artifactId,
        handle.currentVersionId,
        writes.tags,
        newActionKey("visibility"),
      );
    }
    if (writes.accessSetting !== null) {
      await api.changeAccess(
        handle.projectId,
        handle.artifactId,
        handle.currentVersionId,
        writes.accessSetting,
        newActionKey("visibility"),
      );
    }
    toast.success(`${artifact.name} is now ${visibilityLabels[target].toLowerCase()}.`);
    onChanged();
  });
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
              View versions
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
                if (value === "private" || value === "public" || value === "unlisted") {
                  if (value !== artifact.visibility) void changeVisibility(value);
                }
              }}
              value={artifact.visibility}
            >
              <DropdownMenuRadioItem value="public">{visibilityLabels.public}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unlisted">{visibilityLabels.unlisted}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="private">{visibilityLabels.private}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
