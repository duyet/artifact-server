import {IconDownload} from "@tabler/icons-react";

import {api, type ArtifactVersion} from "@/api/client";
import {Button, buttonVariants} from "@/components/ui/button";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";

export interface ReviewDownload {
  readonly href: string;
  readonly title: string;
}

/** One file downloads as itself; several download as one ZIP. */
export function reviewDownload(
  projectId: string,
  artifactId: string | null,
  version: ArtifactVersion | null,
): ReviewDownload | null {
  if (artifactId === null || version === null) return null;
  const entries = version.manifest.entries;
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  if (onlyEntry !== undefined) {
    return {
      href: api.versionFileUrl(projectId, artifactId, version.version.id, onlyEntry.path),
      title: `Download ${onlyEntry.path}`,
    };
  }
  return {
    href: api.versionArchiveUrl(projectId, artifactId, version.version.id),
    title: `Download ${entries.length} files as a ZIP`,
  };
}

/** Icon download control; disabled until a version is readable. */
export function ReviewDownloadControl({
  download,
  variant = "ghost",
}: {
  readonly download: ReviewDownload | null;
  readonly variant?: "ghost" | "secondary";
}) {
  if (download === null) {
    return (
      <Button aria-label="Download" disabled size="icon-sm" variant={variant}>
        <IconDownload />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <a
            aria-label="Download"
            className={buttonVariants({size: "icon-sm", variant})}
            download
            href={download.href}
          />
        )}
      >
        <IconDownload />
      </TooltipTrigger>
      <TooltipContent>{download.title}</TooltipContent>
    </Tooltip>
  );
}
