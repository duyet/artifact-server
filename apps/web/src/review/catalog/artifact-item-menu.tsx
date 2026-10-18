import {
  IconCopy,
  IconCursorText,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconLink,
  IconTrash,
} from "@tabler/icons-react";

import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ArtifactItemAction = "copy-link" | "delete" | "download" | "duplicate" | "open" | "rename";

/** The per-artifact actions menu in the gallery. */
export function ArtifactItemMenu({
  canManage,
  name,
  onAction,
}: {
  readonly canManage: boolean;
  readonly name: string;
  readonly onAction: (action: ArtifactItemAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button aria-label={`Actions for ${name}`} size="icon-sm" variant="ghost" />}>
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAction("open")}>
            <IconExternalLink />
            Open
          </DropdownMenuItem>
          {canManage ? (
            <>
              <DropdownMenuItem onClick={() => onAction("rename")}>
                <IconCursorText />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAction("duplicate")}>
                <IconCopy />
                Duplicate
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onClick={() => onAction("copy-link")}>
            <IconLink />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAction("download")}>
            <IconDownload />
            Download
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {canManage ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => onAction("delete")} variant="destructive">
                <IconTrash />
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
