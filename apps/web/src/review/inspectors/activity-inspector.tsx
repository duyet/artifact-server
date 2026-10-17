import type {ArtifactAction, ArtifactComparison} from "@/api/client";
import {actionLabel, formatTimestamp} from "@/lib/presentation";
import {compactId} from "../review-location.ts";
import {InlineState} from "../review-primitives.tsx";
import {InspectorSection} from "./inspector-layout.tsx";

export function ActivityInspector({
  actions,
  error,
  loading,
  nextCursor,
  onLoadMore,
}: {
  readonly actions: readonly ArtifactAction[];
  readonly error: Error | null;
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly onLoadMore: () => void;
}) {
  return (
    <div className="as-inspector-stack">
      <InspectorSection count={actions.length} title="Artifact activity">
        {error === null ? null : <p className="as-inspector-error" role="alert">{error.message}</p>}
        {actions.length === 0 && loading ? <p className="as-inspector-empty">Loading activity…</p> : null}
        {actions.length === 0 && !loading ? <p className="as-inspector-empty">No activity recorded.</p> : null}
        <ol className="as-activity-list">
          {actions.map((action) => (
            <li key={action.id}>
              <strong>{actionLabel(action.action)}</strong>
              <time dateTime={action.createdAt}>{formatTimestamp(action.createdAt)}</time>
              <code title={action.principalId}>{compactId(action.principalId)}</code>
            </li>
          ))}
        </ol>
        {nextCursor === null ? null : (
          <button className="as-button" disabled={loading} onClick={onLoadMore} type="button">
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </InspectorSection>
    </div>
  );
}

export function ComparisonInspector({
  comparison,
  error,
}: {
  readonly comparison: ArtifactComparison | null;
  readonly error: Error | null;
}) {
  if (error !== null) return <InlineState description={error.message} title="Comparison unavailable" />;
  if (comparison === null) return <InlineState description="Choose two versions from Versions." title="No comparison" />;
  const changedEntries = [
    ...comparison.added.map((entry) => ({kind: "Added", path: entry.path})),
    ...comparison.changed.map((entry) => ({kind: "Changed", path: entry.after.path})),
    ...comparison.removed.map((entry) => ({kind: "Removed", path: entry.path})),
    ...comparison.renamed.map((entry) => ({kind: "Renamed", path: `${entry.from.path} → ${entry.to.path}`})),
  ];
  return (
    <div className="as-inspector-stack">
      <InspectorSection count={2} title={`Version ${comparison.from.number} → ${comparison.to.number}`}>
        <div className="as-comparison-summary">
          <span>{comparison.added.length} added</span>
          <span>{comparison.changed.length} changed</span>
          <span>{comparison.removed.length} removed</span>
          <span>{comparison.renamed.length} renamed</span>
          <span>{comparison.unchangedCount} unchanged</span>
        </div>
      </InspectorSection>
      <InspectorSection count={changedEntries.length} title="Changed files">
        {changedEntries.length === 0 ? <p className="as-inspector-empty">These versions have the same files.</p> : (
          <ol className="as-comparison-list">
            {changedEntries.map((entry) => (
              <li key={`${entry.kind}-${entry.path}`}><span>{entry.kind}</span><code>{entry.path}</code></li>
            ))}
          </ol>
        )}
      </InspectorSection>
    </div>
  );
}

