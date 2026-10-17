import {useMemo, useRef, useState, type FormEvent} from "react";

import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Field, FieldDescription, FieldError, FieldGroup, FieldLabel} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {Spinner} from "@/components/ui/spinner";


import {newActionKey} from "./action-key.js";
import {describeActionError} from "./describe-error.js";
import type {ArtifactActionDialogProps} from "./dialog-props.js";
import {createBrowserTransport, renameArtifact, type ArtifactActionResult} from "./transport.js";

const maximumNameLength = 200;

type RenameArtifactDialogProps = ArtifactActionDialogProps<ArtifactActionResult>;

/** Renames an artifact; the name changes without publishing a new version. */
export function RenameArtifactDialog(props: RenameArtifactDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!busy) props.onOpenChange(next);
      }}
      open={props.open}
    >
      <DialogContent>
        <RenameForm {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  artifact,
  onBusyChange,
  onDone,
  onOpenChange,
  projectId,
}: RenameArtifactDialogProps & {readonly onBusyChange: (busy: boolean) => void}) {
  const transport = useMemo(() => createBrowserTransport(), []);
  const idempotencyKey = useRef(newActionKey("rename"));
  const [name, setName] = useState(artifact.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const trimmed = name.trim();
  const tooLong = Array.from(trimmed).length > maximumNameLength;
  const submittable = trimmed !== "" && !tooLong && trimmed !== artifact.name;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!submittable || pending) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await renameArtifact(transport, {
        artifactId: artifact.id,
        expectedCurrentVersionId: artifact.currentVersionId,
        idempotencyKey: idempotencyKey.current,
        name: trimmed,
        projectId,
      });
      onDone(result);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Rename failed."));
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  };

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Rename artifact</DialogTitle>
        <DialogDescription>
          The name changes everywhere it is listed. Versions and links stay the same.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={tooLong || error !== null ? true : undefined}>
          <FieldLabel htmlFor="rename-artifact-name">Name</FieldLabel>
          <Input
            aria-invalid={tooLong || error !== null ? true : undefined}
            autoFocus
            id="rename-artifact-name"
            onChange={(event) => {
              setName(event.currentTarget.value);
              idempotencyKey.current = newActionKey("rename");
            }}
            value={name}
          />
          {tooLong ? (
            <FieldError>Names are limited to {maximumNameLength} characters.</FieldError>
          ) : error === null ? (
            <FieldDescription>Up to {maximumNameLength} characters.</FieldDescription>
          ) : (
            <FieldError>{describeActionError(error)}</FieldError>
          )}
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={!submittable || pending} type="submit">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
