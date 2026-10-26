import {useEffect, useState} from "react";

import {api, type Artifact, type ArtifactInfo} from "@/api/client";
import {
  type Visibility,
  visibilityOf,
  type VisibilityStep,
  visibilitySteps,
} from "@/lib/visibility";

/** The info popover's data and the one change it can make. */
export interface ArtifactInfoState {
  /** The last visibility change's failure, or null. */
  readonly changeError: string | null;
  readonly changeVisibility: (target: Visibility) => Promise<void>;
  readonly info: ArtifactInfo | null;
  readonly loadError: string | null;
  /** The visibility being applied, or null when no change is running. */
  readonly pendingVisibility: Visibility | null;
  /**
   * Derived from the artifact record the viewer holds, which every write
   * updates at once, so the control never shows a stale value while the info
   * reloads.
   */
  readonly visibility: Visibility | null;
}

/**
 * Read one artifact's info when it opens, and again whenever its access,
 * tags, name, or current version change, wherever the change came from.
 */
export function useArtifactInfo({
  artifact,
  onArtifactChanged,
  projectId,
}: {
  readonly artifact: Artifact | null;
  /** Each write's result, so Share and the inspector stay in step. */
  readonly onArtifactChanged: (artifact: Artifact) => void;
  readonly projectId: string;
}): ArtifactInfoState {
  const [info, setInfo] = useState<ArtifactInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingVisibility, setPendingVisibility] = useState<Visibility | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);

  const artifactId = artifact?.id ?? null;
  const revision = artifact === null
    ? null
    : [
      artifact.currentVersionId,
      artifact.accessSetting,
      artifact.name,
      ...artifact.tags,
    ].join("\u0000");
  useEffect(() => {
    if (artifactId === null || revision === null) return undefined;
    let current = true;
    void (async () => {
      try {
        const loaded = await api.artifactInfo(projectId, artifactId);
        if (!current) return;
        setInfo(loaded);
        setLoadError(null);
      } catch (caught) {
        if (current) {
          setLoadError(caught instanceof Error ? caught.message : "Artifact info could not be read.");
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [artifactId, projectId, revision]);

  const changeVisibility = async (target: Visibility): Promise<void> => {
    if (artifact === null) return;
    setPendingVisibility(target);
    setChangeError(null);
    const apply = async (state: Artifact, step: VisibilityStep): Promise<Artifact> => {
      const changed = step.kind === "access"
        ? await api.changeAccess(
          projectId,
          state.id,
          state.currentVersionId,
          step.accessSetting,
          crypto.randomUUID(),
        )
        : await api.changeTags(
          projectId,
          state.id,
          state.currentVersionId,
          step.tags,
          crypto.randomUUID(),
        );
      onArtifactChanged(changed.artifact);
      return changed.artifact;
    };
    try {
      // The steps run one after another; their order is what keeps every
      // state in between no more exposed than both ends.
      await visibilitySteps(artifact, target).reduce(
        async (previous, step) => apply(await previous, step),
        Promise.resolve(artifact),
      );
    } catch (caught) {
      setChangeError(caught instanceof Error ? caught.message : "Visibility could not be changed.");
    } finally {
      setPendingVisibility(null);
    }
  };

  return {
    changeError,
    changeVisibility,
    info: info?.artifactId === artifactId ? info : null,
    loadError,
    pendingVisibility,
    visibility: artifact === null ? null : visibilityOf(artifact.accessSetting, artifact.tags),
  };
}
