import {useEffect, useState} from "react";

import type {ArtifactDetails, ArtifactVersion} from "@/api/client";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Field, FieldDescription, FieldError, FieldLabel} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {Spinner} from "@/components/ui/spinner";
import {formatTimestamp, sourceDriftDescription, sourceFreshnessLabel} from "@/lib/presentation";
import {AccessBadge} from "../access-badge.tsx";
import {principalLabel} from "../principal-name.ts";
import {InspectorRow, InspectorSection, InspectorStack} from "./inspector-layout.tsx";
import {parseTagList} from "./inspector-model.ts";

export function DetailsInspector({
  canManage,
  details,
  linkedArtifacts,
  onCapture,
  onOpenLive,
  onTagsChange,
  onTombstone,
  version,
  viewerPrincipalId,
}: {
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly linkedArtifacts: boolean;
  readonly onCapture: () => Promise<void>;
  readonly onOpenLive: () => Promise<void>;
  readonly onTagsChange: (tags: readonly string[]) => Promise<void>;
  readonly onTombstone: () => Promise<boolean>;
  readonly version: ArtifactVersion;
  readonly viewerPrincipalId: string;
}) {
  const linkedDriftDescription = details.sourceBinding === undefined
    ? null
    : sourceDriftDescription(details.sourceBinding.status, "captured");
  return (
    <InspectorStack>
      <InspectorSection count={6} title="Artifact">
        <InspectorRow label="name" title={details.artifact.name} value={details.artifact.name} />
        <InspectorRow
          label="owner"
          title={details.artifact.owner.principalId}
          value={principalLabel(details.artifact.owner, viewerPrincipalId)}
        />
        <InspectorRow
          label="access"
          value={<AccessBadge access={details.artifact.accessSetting} />}
        />
        <InspectorRow label="created" title={formatTimestamp(details.artifact.createdAt)} value={formatTimestamp(details.artifact.createdAt)} />
        <InspectorRow label="artifact id" mono title={details.artifact.id} value={details.artifact.id} />
        <InspectorRow label="project id" mono title={details.artifact.projectId} value={details.artifact.projectId} />
      </InspectorSection>
      <InspectorSection count={6} title="Version">
        <InspectorRow label="number" title={String(version.version.number)} value={String(version.version.number)} />
        <InspectorRow
          label="publisher"
          title={version.version.publisherPrincipalId}
          value={principalLabel({
            displayName: version.version.publisherDisplayName,
            principalId: version.version.publisherPrincipalId,
          }, viewerPrincipalId)}
        />
        <InspectorRow label="saved" title={formatTimestamp(version.version.createdAt)} value={formatTimestamp(version.version.createdAt)} />
        <InspectorRow label="entry" mono title={version.manifest.entryPath} value={version.manifest.entryPath} />
        <InspectorRow label="routing" title={version.version.routingMode} value={version.version.routingMode} />
        <InspectorRow label="version id" mono title={version.version.id} value={version.version.id} />
      </InspectorSection>
      <TagsInspector
        artifact={details.artifact}
        key={details.artifact.id}
        onChange={onTagsChange}
      />
      {details.sourceBinding === undefined ? null : (
        <InspectorSection count={2} title="Linked source">
          <InspectorRow label="state" value={sourceFreshnessLabel(details.sourceBinding.status)} />
          <InspectorRow label="path" mono value={details.sourceBinding.path} />
          {linkedDriftDescription === null ? null : (
            <p className="text-sm text-muted-foreground">{linkedDriftDescription}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {canManage && details.sourceBinding.status !== "in-sync" ? (
              <Button onClick={() => void onCapture()} size="sm" type="button">
                Capture current file
              </Button>
            ) : null}
            {linkedArtifacts && details.links.live !== undefined ? (
              <Button onClick={() => void onOpenLive()} size="sm" type="button" variant="outline">
                Open live file
              </Button>
            ) : null}
          </div>
        </InspectorSection>
      )}
      {canManage ? (
        <InspectorSection count={0} title="Danger zone">
          <TombstoneArtifactControl artifact={details.artifact} onConfirm={onTombstone} />
        </InspectorSection>
      ) : null}
    </InspectorStack>
  );
}

export function TagsInspector({
  artifact,
  onChange,
}: {
  readonly artifact: ArtifactDetails["artifact"];
  readonly onChange: (tags: readonly string[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState(artifact.tags.join(", "));
  const inputId = `review-tags-${artifact.id}`;

  useEffect(() => {
    if (!editing) setValue(artifact.tags.join(", "));
  }, [artifact.tags, editing]);

  const cancel = (): void => {
    setEditing(false);
    setError(null);
    setValue(artifact.tags.join(", "));
  };
  const save = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onChange(parseTagList(value));
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Tag update failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <InspectorSection
      action={editing ? null : (
        <Button onClick={() => setEditing(true)} size="xs" type="button" variant="ghost">
          Edit tags
        </Button>
      )}
      count={artifact.tags.length}
      title="Tags"
    >
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field data-invalid={error === null ? undefined : true}>
            <FieldLabel className="sr-only" htmlFor={inputId}>Tags</FieldLabel>
            <Input
              aria-invalid={error === null ? undefined : true}
              autoFocus
              disabled={pending}
              id={inputId}
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="prototype, approved"
              value={value}
            />
            <FieldDescription>
              Separate tags with commas. Saving replaces the complete set.
            </FieldDescription>
            {error === null ? null : <FieldError>{error.message}</FieldError>}
            <div className="flex gap-2">
              <Button disabled={pending} size="sm" type="submit">
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? "Saving…" : "Save tags"}
              </Button>
              <Button disabled={pending} onClick={cancel} size="sm" type="button" variant="outline">
                Cancel
              </Button>
            </div>
          </Field>
        </form>
      ) : artifact.tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tags on this artifact.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {artifact.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
        </div>
      )}
    </InspectorSection>
  );
}

export function TombstoneArtifactControl({
  artifact,
  onConfirm,
}: {
  readonly artifact: ArtifactDetails["artifact"];
  readonly onConfirm: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="w-fit" onClick={() => setOpen(true)} size="sm" type="button" variant="destructive">
        Delete artifact
      </Button>
      <DeleteArtifactDialog artifact={artifact} onConfirm={onConfirm} onOpenChange={setOpen} open={open} />
    </>
  );
}

/** Confirm a tombstone by typing the artifact name. */
export function DeleteArtifactDialog({
  artifact,
  onConfirm,
  onOpenChange,
  open,
}: {
  readonly artifact: Pick<ArtifactDetails["artifact"], "id" | "name">;
  readonly onConfirm: () => Promise<boolean>;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    if (value !== artifact.name) return;
    setPending(true);
    const removed = await onConfirm();
    setPending(false);
    if (removed) {
      setValue("");
      onOpenChange(false);
    }
  };
  return (
    <AlertDialog
      onOpenChange={(nextOpen) => {
        if (pending) return;
        onOpenChange(nextOpen);
        if (!nextOpen) setValue("");
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {artifact.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the artifact from normal use but retains its immutable version records. Type the artifact name to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor={`review-delete-${artifact.id}`}>
            Artifact name
          </FieldLabel>
          <Input
            autoFocus
            id={`review-delete-${artifact.id}`}
            onChange={(event) => setValue(event.currentTarget.value)}
            value={value}
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            disabled={pending || value !== artifact.name}
            onClick={() => void confirm()}
            type="button"
            variant="destructive"
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Deleting…" : "Delete artifact"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
