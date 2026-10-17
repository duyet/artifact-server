import {IconDownload} from "@tabler/icons-react";

import {api, type ArtifactVersion} from "@/api/client";

export interface ReviewDownload {
  readonly href: string;
  readonly title: string;
}

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
      href: api.versionFileUrl(
        projectId,
        artifactId,
        version.version.id,
        onlyEntry.path,
      ),
      title: `Download ${onlyEntry.path}`,
    };
  }
  return {
    href: api.versionArchiveUrl(projectId, artifactId, version.version.id),
    title: `Download ${entries.length} files as a ZIP`,
  };
}

export function ReviewDownloadControl({
  className,
  download,
}: {
  readonly className: string;
  readonly download: ReviewDownload | null;
}) {
  if (download === null) {
    return (
      <button aria-label="Download" className={className} disabled type="button">
        <IconDownload aria-hidden="true" stroke={1.8} />
        <span className="as-button__label">Download</span>
      </button>
    );
  }
  return (
    <a
      aria-label="Download"
      className={className}
      download
      href={download.href}
      title={download.title}
    >
      <IconDownload aria-hidden="true" stroke={1.8} />
      <span className="as-button__label">Download</span>
    </a>
  );
}

