import {useState} from "react";
import {Dialog} from "@base-ui/react/dialog";

import type {Version} from "@/api/client";
import {formatTimestamp} from "@/lib/presentation";
import {compactId} from "../review-location.ts";
import {InspectorSection} from "./inspector-layout.tsx";

export interface VersionListItem {
  readonly links: {readonly review: string; readonly version: string};
  readonly version: Version;
}

export function VersionsInspector({
  canManage,
  comparisonLoading,
  currentVersionId,
  onCompare,
  onMakeCurrent,
  onSelect,
  selectedVersionId,
  versions,
}: {
  readonly canManage: boolean;
  readonly comparisonLoading: boolean;
  readonly currentVersionId: string;
  readonly onCompare: (fromVersionId: string, toVersionId: string) => Promise<void>;
  readonly onMakeCurrent: (
    versionId: string,
    expectedCurrentVersionId: string,
  ) => Promise<boolean>;
  readonly onSelect: (versionId: string) => void;
  readonly selectedVersionId: string | null;
  readonly versions: readonly VersionListItem[];
}) {
  const [fromVersionId, setFromVersionId] = useState(
    versions.at(-1)?.version.id ?? currentVersionId,
  );
  const [toVersionId, setToVersionId] = useState(currentVersionId);
  return (
    <div className="as-inspector-stack">
      {versions.length < 2 ? null : (
        <InspectorSection count={2} title="Compare versions">
          <form
            className="as-compare-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onCompare(fromVersionId, toVersionId);
            }}
          >
            <label>
              <span>From</span>
              <select onChange={(event) => setFromVersionId(event.currentTarget.value)} value={fromVersionId}>
                {versions.map(({version}) => <option key={version.id} value={version.id}>Version {version.number}</option>)}
              </select>
            </label>
            <label>
              <span>To</span>
              <select onChange={(event) => setToVersionId(event.currentTarget.value)} value={toVersionId}>
                {versions.map(({version}) => <option key={version.id} value={version.id}>Version {version.number}</option>)}
              </select>
            </label>
            <button className="as-button" disabled={comparisonLoading || fromVersionId === toVersionId} type="submit">
              {comparisonLoading ? "Comparing…" : "Compare"}
            </button>
          </form>
        </InspectorSection>
      )}
      <InspectorSection count={versions.length} title="Immutable history">
        <ol className="as-version-list">
          {versions.map(({version}) => (
            <li key={version.id}>
              <div className="as-version-list__row">
                <button
                  aria-current={selectedVersionId === version.id ? "true" : undefined}
                  className="as-version-list__select"
                  data-selected={selectedVersionId === version.id}
                  onClick={() => onSelect(version.id)}
                  type="button"
                >
                  <span>
                    <strong>Version {version.number}</strong>
                    <time dateTime={version.createdAt}>{formatTimestamp(version.createdAt)}</time>
                  </span>
                  <span className="as-version-list__state">
                    {version.id === currentVersionId ? "current" : compactId(version.id)}
                  </span>
                </button>
                {!canManage || version.id === currentVersionId ? null : (
                  <MakeCurrentControl
                    expectedCurrentVersionId={currentVersionId}
                    onConfirm={onMakeCurrent}
                    version={version}
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      </InspectorSection>
    </div>
  );
}

export function MakeCurrentControl({
  expectedCurrentVersionId,
  onConfirm,
  version,
}: {
  readonly expectedCurrentVersionId: string;
  readonly onConfirm: (
    versionId: string,
    expectedCurrentVersionId: string,
  ) => Promise<boolean>;
  readonly version: Version;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    setPending(true);
    await onConfirm(version.id, expectedCurrentVersionId);
    setPending(false);
    setOpen(false);
  };
  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="as-version-list__make-current">
        Make current
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="as-confirm-dialog__backdrop" />
        <Dialog.Popup className="as-confirm-dialog">
          <Dialog.Title>Make Version {version.number} current?</Dialog.Title>
          <Dialog.Description>
            The stable artifact link will point to Version {version.number}. No saved version is changed or duplicated.
          </Dialog.Description>
          <div className="as-confirm-dialog__actions">
            <Dialog.Close className="as-button" disabled={pending}>Cancel</Dialog.Close>
            <button
              className="as-button as-button--primary"
              disabled={pending}
              onClick={() => void confirm()}
              type="button"
            >
              {pending ? "Making current…" : "Make current"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

