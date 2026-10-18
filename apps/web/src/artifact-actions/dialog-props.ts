import type {Artifact, ArtifactVersion} from "@/api/client";

/** Props every artifact action dialog takes. */
export interface ArtifactActionDialogProps<Result> {
  /** The artifact as the caller last read it; its current version guards writes. */
  readonly artifact: Artifact;
  readonly onDone: (result: Result) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly projectId: string;
  /** The version being viewed: its manifest supplies the files to act on. */
  readonly version: ArtifactVersion;
}
