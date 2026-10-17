import {useEffect, useState} from "react";
import {Dialog} from "@base-ui/react/dialog";

import type {ArtifactDetails, ArtifactVersion} from "@/api/client";
import {formatTimestamp, sourceDriftDescription, sourceFreshnessLabel} from "@/lib/presentation";
import {AccessPill} from "../review-primitives.tsx";
import {InspectorRow, InspectorSection} from "./inspector-layout.tsx";

export function DetailsInspector({
  canManage,
  details,
  linkedArtifacts,
  onCapture,
  onOpenLive,
  onTagsChange,
  onTombstone,
  version,
}: {
  readonly canManage: boolean;
  readonly details: ArtifactDetails;
  readonly linkedArtifacts: boolean;
  readonly onCapture: () => Promise<void>;
  readonly onOpenLive: () => Promise<void>;
  readonly onTagsChange: (tags: readonly string[]) => Promise<void>;
  readonly onTombstone: () => Promise<boolean>;
  readonly version: ArtifactVersion;
}) {
  const linkedDriftDescription = details.sourceBinding === undefined
    ? null
    : sourceDriftDescription(details.sourceBinding.status, "captured");
  return (
    <div className="as-inspector-stack">
      <InspectorSection count={5} title="Artifact">
        <InspectorRow label="name" title={details.artifact.name} value={details.artifact.name} />
        <InspectorRow
          label="access"
          value={<AccessPill access={details.artifact.accessSetting} />}
        />
        <InspectorRow label="created" title={formatTimestamp(details.artifact.createdAt)} value={formatTimestamp(details.artifact.createdAt)} />
        <InspectorRow label="artifact id" mono title={details.artifact.id} value={details.artifact.id} />
        <InspectorRow label="project id" mono title={details.artifact.projectId} value={details.artifact.projectId} />
      </InspectorSection>
      <InspectorSection count={5} title="Version">
        <InspectorRow label="number" title={String(version.version.number)} value={String(version.version.number)} />
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
            <p className="as-inspector-empty">{linkedDriftDescription}</p>
          )}
          <div className="as-inspector-actions">
            {canManage && details.sourceBinding.status !== "in-sync" ? (
              <button className="as-button as-button--primary" onClick={() => void onCapture()} type="button">
                Capture current file
              </button>
            ) : null}
            {linkedArtifacts && details.links.live !== undefined ? (
              <button className="as-button" onClick={() => void onOpenLive()} type="button">
                Open live file
              </button>
            ) : null}
          </div>
        </InspectorSection>
      )}
      {canManage ? (
        <InspectorSection count={0} title="Danger zone">
          <TombstoneArtifactControl artifact={details.artifact} onConfirm={onTombstone} />
        </InspectorSection>
      ) : null}
    </div>
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
      await onChange(
        value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== ""),
      );
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
        <button
          className="as-inspector-section__action"
          onClick={() => setEditing(true)}
          type="button"
        >
          Edit tags
        </button>
      )}
      count={artifact.tags.length}
      title="Tags"
    >
      {editing ? (
        <form
          className="as-tag-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="as-visually-hidden" htmlFor={`review-tags-${artifact.id}`}>
            Tags
          </label>
          <input
            autoFocus
            disabled={pending}
            id={`review-tags-${artifact.id}`}
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder="prototype, approved"
            value={value}
          />
          <p>Separate tags with commas. Saving replaces the complete set.</p>
          {error === null ? null : (
            <p className="as-tag-editor__error" role="alert">{error.message}</p>
          )}
          <div className="as-tag-editor__actions">
            <button className="as-button as-button--primary" disabled={pending} type="submit">
              {pending ? "Saving…" : "Save tags"}
            </button>
            <button className="as-button" disabled={pending} onClick={cancel} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : artifact.tags.length === 0 ? (
        <p className="as-inspector-empty">No tags on this artifact.</p>
      ) : artifact.tags.map((tag) => (
        <span className="as-tag" key={tag}>{tag}</span>
      ))}
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
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    if (value !== artifact.name) return;
    setPending(true);
    const removed = await onConfirm();
    setPending(false);
    if (removed) setOpen(false);
  };
  return (
    <Dialog.Root onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setValue("");
    }} open={open}>
      <Dialog.Trigger className="as-button as-button--danger">Delete artifact</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="as-confirm-dialog__backdrop" />
        <Dialog.Popup className="as-confirm-dialog">
          <Dialog.Title>Delete {artifact.name}?</Dialog.Title>
          <Dialog.Description>
            This removes the artifact from normal use but retains its immutable version records. Type the artifact name to confirm.
          </Dialog.Description>
          <label>
            <span className="as-visually-hidden">Artifact name</span>
            <input autoFocus onChange={(event) => setValue(event.currentTarget.value)} value={value} />
          </label>
          <div className="as-confirm-dialog__actions">
            <Dialog.Close className="as-button">Cancel</Dialog.Close>
            <button className="as-button as-button--danger" disabled={pending || value !== artifact.name} onClick={() => void confirm()} type="button">
              {pending ? "Deleting…" : "Delete artifact"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

