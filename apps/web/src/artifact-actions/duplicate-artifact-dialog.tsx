import {IconExternalLink} from "@tabler/icons-react";
import {useMemo, useRef, useState} from "react";

import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Progress, ProgressLabel, ProgressValue} from "@/components/ui/progress";
import {Spinner} from "@/components/ui/spinner";
import {formatBytes} from "@/lib/presentation";

import {newActionKey} from "./action-key.js";
import {describeActionError} from "./describe-error.js";
import type {ArtifactActionDialogProps} from "./dialog-props.js";
import {
  duplicateArtifact,
  duplicateName,
  type DuplicateProgress,
} from "./duplicate-artifact.js";
import {createBrowserTransport, type ArtifactActionResult} from "./transport.js";

type DuplicateArtifactDialogProps = ArtifactActionDialogProps<ArtifactActionResult>;

const phaseLabels = {
  committing: "Publishing the copy",
  copying: "Copying files",
  planning: "Preparing the upload",
} satisfies Record<DuplicateProgress["phase"], string>;

/** Copies an artifact version into a new private artifact named "<name> (copy)". */
export function DuplicateArtifactDialog(props: DuplicateArtifactDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!busy) props.onOpenChange(next);
      }}
      open={props.open}
    >
      <DialogContent>
        <DuplicateBody {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function DuplicateBody({
  artifact,
  onBusyChange,
  onDone,
  onOpenChange,
  projectId,
  version,
}: DuplicateArtifactDialogProps & {readonly onBusyChange: (busy: boolean) => void}) {
  const transport = useMemo(() => createBrowserTransport(), []);
  const idempotencyKey = useRef(newActionKey("duplicate"));
  const [progress, setProgress] = useState<DuplicateProgress | null>(null);
  const [created, setCreated] = useState<ArtifactActionResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const entries = version.manifest.entries;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const running = progress !== null && created === null && error === null;
  const percent = progress === null || progress.totalFiles === 0
    ? 0
    : Math.round((progress.copiedFiles / progress.totalFiles) * 100);

  const start = async () => {
    setError(null);
    setProgress({copiedFiles: 0, phase: "planning", totalFiles: entries.length});
    onBusyChange(true);
    try {
      const result = await duplicateArtifact(transport, {
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactTags: artifact.tags,
        idempotencyKey: idempotencyKey.current,
        manifest: version.manifest,
        onProgress: setProgress,
        projectId,
        versionId: version.version.id,
      });
      setCreated(result);
      onDone(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Duplicating failed."));
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Duplicate artifact</DialogTitle>
        <DialogDescription>
          Creates a private copy named {duplicateName(artifact.name)} with the same files and tags.
          The original is not changed.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        {entries.length} {entries.length === 1 ? "file" : "files"}, {formatBytes(totalBytes)}, copied from version {version.version.number}.
      </p>
      {progress === null || created !== null ? null : (
        <Progress value={percent}>
          <ProgressLabel>{phaseLabels[progress.phase]}</ProgressLabel>
          <ProgressValue />
        </Progress>
      )}
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>The copy was not created</AlertTitle>
          <AlertDescription>{describeActionError(error)}</AlertDescription>
        </Alert>
      )}
      {created === null ? null : (
        <Alert>
          <AlertTitle>{created.artifact.name}</AlertTitle>
          <AlertDescription>
            The copy is ready. Only you can open it until you share it.
          </AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        {created === null ? (
          <>
            <Button disabled={running} onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={running} onClick={() => void start()} type="button">
              {running ? <Spinner data-icon="inline-start" /> : null}
              {error === null ? "Duplicate" : "Try again"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
            <Button
              nativeButton={false}
              render={<a href={created.links.review ?? created.links.artifact} />}
            >
              <IconExternalLink data-icon="inline-start" />
              Open copy
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
