import {useEffect, useState} from "react";

import {
  api,
  type Artifact,
  hasBrowserSession,
  type PublicArtifactInfo,
} from "@/api/client";
import type {Account} from "@/account/account-menu";
import {
  type ArtifactInfoState,
  useArtifactInfo,
} from "@/review/viewer/use-artifact-info";

/** A signed-in reader and the artifact record their session may read. */
interface SignedInReader {
  readonly artifact: Artifact;
  readonly principalId: string;
}

/**
 * Who reads the page. A browser that holds a session is `checking` until the
 * session answers, so the bar never offers Sign in to someone signed in.
 */
export type ReadableReader =
  | {readonly kind: "anonymous"}
  | {readonly kind: "checking"}
  | {readonly account: Account; readonly kind: "member"};

/** What the readable-URL bar knows about the artifact it frames. */
export interface ReadableArtifact {
  /** The public artifact's ID, once its info has loaded. */
  readonly artifactId: string | null;
  /** The popover's data: read-only for anyone who may not manage the artifact. */
  readonly info: ArtifactInfoState;
  readonly name: string | null;
  readonly owner: Artifact["owner"] | null;
  readonly reader: ReadableReader;
  /** Review's page for this artifact, offered only to a signed-in reader. */
  readonly reviewUrl: string | null;
  readonly viewerPrincipalId: string;
}

/**
 * Read the public artifact served at `pathname` and, when this browser holds
 * a session, the reader's account and their own view of the artifact, which
 * says whether they may change its visibility. An anonymous reader never
 * makes those reads.
 */
export function useReadableArtifact(pathname: string): ReadableArtifact {
  const [published, setPublished] = useState<PublicArtifactInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reader, setReader] = useState<SignedInReader | null>(null);
  const [readerAccount, setReaderAccount] = useState<ReadableReader>(() =>
    hasBrowserSession() ? {kind: "checking"} : {kind: "anonymous"});

  useEffect(() => {
    let current = true;
    const session = hasBrowserSession() ? api.session() : null;
    const readAccount = async (pending: NonNullable<typeof session>) => {
      let account: ReadableReader;
      try {
        account = {account: (await pending).account, kind: "member"};
      } catch {
        // An expired session reads as anonymous, so the bar offers Sign in.
        account = {kind: "anonymous"};
      }
      if (current) setReaderAccount(account);
    };
    if (session !== null) void readAccount(session);
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
      if (session === null) return;
      try {
        const [signedIn, details] = await Promise.all([
          session,
          api.artifact(loaded.projectId, loaded.artifactId),
        ]);
        if (current) {
          setReader({artifact: details.artifact, principalId: signedIn.principal.id});
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
      artifactId: published.artifactId,
      // The public info stays up until the reader's own info arrives.
      info: managed.info === null ? {...managed, info: published, loadError: null} : managed,
      name: reader.artifact.name,
      owner: reader.artifact.owner,
      reader: readerAccount,
      reviewUrl: `/review?${new URLSearchParams({
        artifact: reader.artifact.id,
        project: reader.artifact.projectId,
      })}`,
      viewerPrincipalId: reader.principalId,
    };
  }
  return {
    artifactId: published?.artifactId ?? null,
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
    reader: readerAccount,
    reviewUrl: null,
    viewerPrincipalId: "",
  };
}
