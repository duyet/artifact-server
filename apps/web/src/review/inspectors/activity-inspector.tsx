import {IconGitCompare, IconHistoryOff} from "@tabler/icons-react";

import type {ArtifactAction, ArtifactComparison} from "@/api/client";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from "@/components/ui/empty";
import {Item, ItemContent, ItemDescription, ItemGroup, ItemTitle} from "@/components/ui/item";
import {Skeleton} from "@/components/ui/skeleton";
import {Spinner} from "@/components/ui/spinner";
import {actionLabel, formatTimestamp} from "@/lib/presentation";
import {compactId} from "../review-location.ts";
import {InspectorSection, InspectorStack} from "./inspector-layout.tsx";
import {changedFiles} from "./inspector-model.ts";

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
    <InspectorStack>
      <InspectorSection count={actions.length} title="Artifact activity">
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {actions.length === 0 && loading ? <ActivitySkeleton /> : null}
        {actions.length === 0 && !loading ? (
          <Empty className="p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon"><IconHistoryOff /></EmptyMedia>
              <EmptyTitle>No activity recorded.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        {actions.length === 0 ? null : (
          <ItemGroup aria-label="Artifact activity" className="gap-1">
            {actions.map((action) => (
              <Item key={action.id} role="listitem" size="xs">
                <ItemContent>
                  <ItemTitle>{actionLabel(action.action)}</ItemTitle>
                  <ItemDescription className="flex items-center justify-between gap-2">
                    <time dateTime={action.createdAt}>{formatTimestamp(action.createdAt)}</time>
                    <code className="truncate font-mono text-xs" title={action.principalId}>
                      {compactId(action.principalId)}
                    </code>
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
        {nextCursor === null ? null : (
          <Button className="w-fit" disabled={loading} onClick={onLoadMore} size="sm" type="button" variant="outline">
            {loading ? <Spinner data-icon="inline-start" /> : null}
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
      </InspectorSection>
    </InspectorStack>
  );
}

function ActivitySkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2" role="status">
      <span className="sr-only">Loading activity…</span>
      {[0, 1, 2].map((row) => (
        <div className="flex flex-col gap-1.5 px-2.5 py-2" key={row}>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
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
  if (error !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><IconGitCompare /></EmptyMedia>
          <EmptyTitle>Comparison unavailable</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (comparison === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><IconGitCompare /></EmptyMedia>
          <EmptyTitle>No comparison</EmptyTitle>
          <EmptyDescription>Choose two versions from Versions.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const changed = changedFiles(comparison);
  return (
    <InspectorStack>
      <InspectorSection count={2} title={`Version ${comparison.from.number} → ${comparison.to.number}`}>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{comparison.added.length} added</Badge>
          <Badge variant="secondary">{comparison.changed.length} changed</Badge>
          <Badge variant="secondary">{comparison.removed.length} removed</Badge>
          <Badge variant="secondary">{comparison.renamed.length} renamed</Badge>
          <Badge variant="outline">{comparison.unchangedCount} unchanged</Badge>
        </div>
      </InspectorSection>
      <InspectorSection count={changed.length} title="Changed files">
        {changed.length === 0 ? (
          <p className="text-sm text-muted-foreground">These versions have the same files.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {changed.map((entry) => (
              <li className="flex items-center gap-2" key={`${entry.kind}-${entry.path}`}>
                <Badge className="shrink-0" variant="outline">{entry.kind}</Badge>
                <code className="min-w-0 truncate font-mono text-xs" title={entry.path}>{entry.path}</code>
              </li>
            ))}
          </ol>
        )}
      </InspectorSection>
    </InspectorStack>
  );
}
