import {useCallback, useEffect, useState} from "react";

import {
  api,
  ApiError,
  type Artifact,
  type ArtifactAction,
  type ArtifactComparison,
  type ArtifactDetails,
  type ArtifactVersion,
} from "@/api/client";
import type {VersionListItem} from "../inspectors/versions-inspector.tsx";

interface ArtifactViewerOptions {
  readonly artifactId: string;
  /** The artifact record changed (tags, access, name, current version). */
  readonly onArtifactChanged: (artifact: Artifact) => void;
  /** The viewer chose the current version on its own. */
  readonly onVersionResolved: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}

/** Everything the viewer reads about one artifact, and what it can change. */
export interface ArtifactViewer {
  readonly actionNextCursor: string | null;
  readonly actions: readonly ArtifactAction[];
  readonly activityError: Error | null;
  readonly activityLoading: boolean;
  readonly changeTags: (tags: readonly string[]) => Promise<void>;
  readonly clearError: () => void;
  readonly compareVersions: (fromVersionId: string, toVersionId: string) => Promise<boolean>;
  readonly comparison: ArtifactComparison | null;
  readonly comparisonError: Error | null;
  readonly comparisonLoading: boolean;
  readonly details: ArtifactDetails | null;
  readonly error: Error | null;
  readonly loadActions: (cursor: string | null) => Promise<void>;
  readonly loading: boolean;
  readonly makeVersionCurrent: (versionId: string, expectedCurrentVersionId: string) => Promise<boolean>;
  readonly openRawArtifact: () => Promise<void>;
  readonly opening: boolean;
  readonly reload: () => Promise<void>;
  readonly selectedVersion: ArtifactVersion | null;
  readonly tombstoneArtifact: () => Promise<boolean>;
  readonly updateArtifact: (artifact: Artifact) => void;
  readonly versions: readonly VersionListItem[];
}

/** Load one artifact, its history, and the selected version, and act on it. */
export function useArtifactViewer({
  artifactId,
  onArtifactChanged,
  onVersionResolved,
  projectId,
  versionId,
}: ArtifactViewerOptions): ArtifactViewer {
  const [details, setDetails] = useState<ArtifactDetails | null>(null);
  const [versions, setVersions] = useState<readonly VersionListItem[]>([]);
  const [fetchedVersion, setFetchedVersion] = useState<ArtifactVersion | null>(null);
  const [actions, setActions] = useState<readonly ArtifactAction[]>([]);
  const [actionNextCursor, setActionNextCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<Error | null>(null);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let current = true;
    setActions([]);
    setActionNextCursor(null);
    setComparison(null);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [loadedDetails, loadedVersions] = await Promise.all([
          api.artifact(projectId, artifactId),
          api.versions(projectId, artifactId),
        ]);
        if (!current) return;
        setDetails(loadedDetails);
        setVersions(loadedVersions);
      } catch (caught) {
        if (!current) return;
        setDetails(null);
        setVersions([]);
        setError(caught instanceof Error ? caught : new Error("Artifact details failed."));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, projectId]);

  const loadedArtifactId = details?.artifact.id ?? null;
  const loadedCurrentVersionId = details?.current.version.id ?? null;
  useEffect(() => {
    if (versionId === null && loadedArtifactId === artifactId && loadedCurrentVersionId !== null) {
      onVersionResolved(loadedCurrentVersionId);
    }
  }, [artifactId, loadedArtifactId, loadedCurrentVersionId, onVersionResolved, versionId]);

  // Keyed on ids, not on the details object. A tags or access change replaces
  // that object and must not read the open version again or remount its
  // preview.
  useEffect(() => {
    setFetchedVersion(null);
    if (
      loadedArtifactId !== artifactId
      || loadedCurrentVersionId === null
      || versionId === null
      || versionId === loadedCurrentVersionId
    ) {
      return undefined;
    }
    let current = true;
    void (async () => {
      try {
        const loaded = await api.version(projectId, artifactId, versionId);
        if (current) setFetchedVersion(loaded);
      } catch (caught) {
        if (current) setError(caught instanceof Error ? caught : new Error("Version loading failed."));
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, loadedArtifactId, loadedCurrentVersionId, projectId, versionId]);
  const currentDetails = details?.artifact.id === artifactId ? details : null;
  const selectedVersion = currentDetails === null || versionId === null
    ? null
    : versionId === currentDetails.current.version.id
      ? currentDetails.current
      : fetchedVersion?.version.id === versionId
        ? fetchedVersion
        : null;

  const updateArtifact = useCallback((artifact: Artifact): void => {
    setDetails((current) => current?.artifact.id === artifact.id ? {...current, artifact} : current);
    onArtifactChanged(artifact);
  }, [onArtifactChanged]);

  const reload = useCallback(async (): Promise<void> => {
    const [loadedDetails, loadedVersions] = await Promise.all([
      api.artifact(projectId, artifactId),
      api.versions(projectId, artifactId),
    ]);
    setDetails(loadedDetails);
    setVersions(loadedVersions);
    onArtifactChanged(loadedDetails.artifact);
  }, [artifactId, onArtifactChanged, projectId]);

  const loadActions = useCallback(async (cursor: string | null): Promise<void> => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const page = await api.actions(projectId, artifactId, cursor);
      setActions((current) => cursor === null ? page.actions : [...current, ...page.actions]);
      setActionNextCursor(page.nextCursor);
    } catch (caught) {
      setActivityError(caught instanceof Error ? caught : new Error("Activity loading failed."));
    } finally {
      setActivityLoading(false);
    }
  }, [artifactId, projectId]);

  const openInNewTab = async (
    issue: () => Promise<{readonly bootstrapUrl: string}>,
    failure: string,
  ): Promise<void> => {
    const popup = window.open("about:blank", "_blank");
    setError(null);
    try {
      const issued = await issue();
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setError(caught instanceof Error ? caught : new Error(failure));
    }
  };

  const openRawArtifact = async (): Promise<void> => {
    if (versionId === null) return;
    setOpening(true);
    try {
      await openInNewTab(
        () => api.contentSession(projectId, artifactId, versionId),
        "Artifact opening failed.",
      );
    } finally {
      setOpening(false);
    }
  };

  const changeTags = async (tags: readonly string[]): Promise<void> => {
    if (details === null) return;
    const changed = await api.changeTags(
      projectId,
      artifactId,
      details.artifact.currentVersionId,
      tags,
      crypto.randomUUID(),
    );
    updateArtifact(changed.artifact);
  };

  const makeVersionCurrent = async (
    nextVersionId: string,
    expectedCurrentVersionId: string,
  ): Promise<boolean> => {
    setError(null);
    try {
      const restored = await api.restore(
        projectId,
        artifactId,
        expectedCurrentVersionId,
        nextVersionId,
        crypto.randomUUID(),
      );
      updateArtifact(restored.artifact);
      await reload();
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          await reload();
        } catch {
          // Keep the original conflict visible when refreshing pointer state fails.
        }
        setError(new Error(
          "The current version changed before this action completed. Nothing was changed; the latest version state has been reloaded.",
        ));
        return false;
      }
      setError(caught instanceof Error ? caught : new Error("The version could not be made current."));
      return false;
    }
  };

  const compareVersions = async (fromVersionId: string, toVersionId: string): Promise<boolean> => {
    if (fromVersionId === toVersionId) return false;
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      setComparison(await api.comparison(projectId, artifactId, fromVersionId, toVersionId));
      return true;
    } catch (caught) {
      setComparisonError(caught instanceof Error ? caught : new Error("Version comparison failed."));
      return false;
    } finally {
      setComparisonLoading(false);
    }
  };

  const tombstoneArtifact = async (): Promise<boolean> => {
    if (details === null) return false;
    setError(null);
    try {
      await api.deleteArtifact(
        projectId,
        artifactId,
        details.artifact.currentVersionId,
        crypto.randomUUID(),
      );
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Artifact deletion failed."));
      return false;
    }
  };

  return {
    actionNextCursor,
    actions,
    activityError,
    activityLoading,
    changeTags,
    clearError: () => setError(null),
    compareVersions,
    comparison,
    comparisonError,
    comparisonLoading,
    details: currentDetails,
    error,
    loadActions,
    loading,
    makeVersionCurrent,
    openRawArtifact,
    opening,
    reload,
    selectedVersion,
    tombstoneArtifact,
    updateArtifact,
    versions,
  };
}
