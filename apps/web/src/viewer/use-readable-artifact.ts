import {useEffect, useState} from "react";

import {
  api,
  type Artifact,
  hasBrowserSession,
  type PublicArtifactInfo,
} from "@/api/client";
import {
  type ArtifactInfoState,
  useArtifactInfo,
} from "@/review/viewer/use-artifact-info";

/** A signed-in reader and the artifact record their session may read. */
interface SignedInReader {
  readonly artifact: Artifact;
  readonly principalId: string;
}

/** What the readable-URL bar knows about the artifact it frames. */
export interface ReadableArtifact {
  /** The popover's data: read-only for anyone who may not manage the artifact. */
  readonly info: ArtifactInfoState;
  readonly name: string | null;
  readonly owner: Artifact["owner"] | null;
  /** Review's page for this artifact, offered only to a signed-in reader. */
  readonly reviewUrl: string | null;
  readonly viewerPrincipalId: string;
}

/**
 * Read the public artifact served at `pathname`, then, when this browser
 * holds a session, the reader's own view of it, which says whether they may
 * change its visibility. An anonymous reader never makes the second read.
 */
export function useReadableArtifact(pathname: string): ReadableArtifact {
  const [published, setPublished] = useState<PublicArtifactInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reader, setReader] = useState<SignedInReader | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      let loaded: PublicArtifactInfo;
      try {
        loaded = await api.publicArtifactInfo(pathname);
      } catch (caught) {
        if (current) {
          setLoadError(caught instanceof Error ? caught.message : "Artifact info could not be read.");
        }
        return;
      }
      if (!current) return;
      setPublished(loaded);
      if (!hasBrowserSession()) return;
      try {
        const [session, details] = await Promise.all([
          api.session(),
          api.artifact(loaded.projectId, loaded.artifactId),
        ]);
        if (current) {
          setReader({artifact: details.artifact, principalId: session.principal.id});
        }
      } catch {
        // An expired session or a reader who may not open the artifact in
        // Review sees what an anonymous reader sees.
      }
    })();
    return () => {
      current = false;
    };
  }, [pathname]);

  const managed = useArtifactInfo({
    artifact: reader?.artifact ?? null,
    onArtifactChanged: (artifact) => {
      setReader((previous) => previous === null ? null : {...previous, artifact});
    },
    projectId: published?.projectId ?? "",
  });

  if (reader !== null && published !== null) {
    return {
      // The public info stays up until the reader's own info arrives.
      info: managed.info === null ? {...managed, info: published, loadError: null} : managed,
      name: reader.artifact.name,
      owner: reader.artifact.owner,
      reviewUrl: `/review?${new URLSearchParams({
        artifact: reader.artifact.id,
        project: reader.artifact.projectId,
      })}`,
      viewerPrincipalId: reader.principalId,
    };
  }
  return {
    info: {
      changeError: null,
      changeVisibility: async () => {},
      info: published,
      loadError,
      pendingVisibility: null,
      visibility: null,
    },
    name: published?.name ?? null,
    owner: null,
    reviewUrl: null,
    viewerPrincipalId: "",
  };
}
