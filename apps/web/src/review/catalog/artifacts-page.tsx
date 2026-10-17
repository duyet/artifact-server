import {useState} from "react";
import {
  IconCheck,
  IconEye,
  IconFileText,
  IconLayoutGrid,
  IconList,
  IconMessage,
  IconRefresh,
  IconStack2,
} from "@tabler/icons-react";
import {toast} from "sonner";

import {api, type ArtifactDetails, type ArtifactOwnerScope, type Project, type Session} from "@/api/client";
import {
  DuplicateArtifactDialog,
  RenameArtifactDialog,
  type ArtifactActionResult,
} from "@/artifact-actions";
import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from "@/components/ui/empty";
import {Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Skeleton} from "@/components/ui/skeleton";
import {Tabs, TabsList, TabsTrigger} from "@/components/ui/tabs";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {cn} from "@/lib/utils";
import {AccessBadge} from "../access-badge.tsx";
import {OwnerAvatar} from "../owner-avatar.tsx";
import {OwnerHoverCard} from "../owner-hover-card.tsx";
import {principalLabel} from "../principal-name.ts";
import {DeleteArtifactDialog} from "../inspectors/details-inspector.tsx";
import {reviewDownload} from "../review-download.tsx";
import {reviewHref} from "../review-location.ts";
import type {ReviewPermissions} from "../review-permissions.ts";
import {ArtifactItemMenu, type ArtifactItemAction} from "./artifact-item-menu.tsx";
import {CatalogFilters} from "./catalog-filters.tsx";
import {groupByDay, relativeTime} from "./catalog-time.ts";
import {OnboardingCard} from "./onboarding-card.tsx";
import type {ArtifactCatalog, CatalogItem, CatalogSort} from "./use-artifact-catalog.ts";

type GalleryLayout = "grid" | "list";
type DialogAction = "delete" | "duplicate" | "rename";

const sortItems = [
  {label: "Newest first", value: "newest"},
  {label: "Most comments", value: "comments"},
] as const satisfies readonly {readonly label: string; readonly value: CatalogSort}[];

const layoutKey = "artifact-review-gallery-layout";

function readLayout(): GalleryLayout {
  try {
    return window.localStorage.getItem(layoutKey) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function artifactHref(projectId: string, item: CatalogItem): string {
  return reviewHref({
    artifactId: item.artifact.id,
    path: null,
    projectId,
    versionId: null,
    view: null,
  });
}

/** The project's artifacts as a searchable gallery, grouped by day. */
export function ArtifactsPage({
  catalog,
  permissions,
  project,
  projectId,
  onCatalogStale,
  onOpenArtifact,
  session,
}: {
  readonly catalog: ArtifactCatalog;
  readonly onCatalogStale: () => void;
  readonly onOpenArtifact: (artifactId: string, versionId: string | null) => void;
  readonly permissions: ReviewPermissions;
  readonly project: Project | null;
  readonly projectId: string;
  readonly session: Session;
}) {
  const [layout, setLayout] = useState<GalleryLayout>(readLayout);
  const [refreshing, setRefreshing] = useState<"complete" | "idle" | "loading">("idle");
  const [pending, setPending] = useState<{readonly action: DialogAction; readonly details: ArtifactDetails} | null>(null);
  const [now] = useState(() => new Date());
  const groups = groupByDay(catalog.items, (item) => item.updatedAt, now);

  const changeLayout = (next: GalleryLayout): void => {
    setLayout(next);
    try {
      window.localStorage.setItem(layoutKey, next);
    } catch {
      // The layout still changes for this page when storage is unavailable.
    }
  };
  const refresh = async (): Promise<void> => {
    setRefreshing("loading");
    const loaded = await catalog.refresh();
    setRefreshing(loaded ? "complete" : "idle");
    if (loaded) window.setTimeout(() => setRefreshing("idle"), 1_600);
  };
  const act = async (action: ArtifactItemAction, item: CatalogItem): Promise<void> => {
    if (action === "open") {
      onOpenArtifact(item.artifact.id, item.artifact.currentVersionId);
      return;
    }
    if (action === "copy-link") {
      try {
        await navigator.clipboard.writeText(new URL(artifactHref(projectId, item), window.location.origin).toString());
        toast.success("Review link copied");
      } catch {
        toast.error("The link could not be copied.");
      }
      return;
    }
    try {
      const details = await api.artifact(projectId, item.artifact.id);
      if (action === "download") {
        const download = reviewDownload(projectId, item.artifact.id, details.current);
        if (download !== null) {
          const anchor = document.createElement("a");
          anchor.href = download.href;
          anchor.download = "";
          anchor.click();
        }
        return;
      }
      setPending({action, details});
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The artifact could not be read.");
    }
  };
  const closeDialog = (open: boolean): void => {
    if (!open) setPending(null);
  };
  const onDuplicated = (result: ArtifactActionResult): void => {
    setPending(null);
    onCatalogStale();
    onOpenArtifact(result.artifact.id, result.version.id);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
      <OnboardingCard projectId={projectId} />
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Artifacts</h1>
        <p className="text-sm text-muted-foreground">
          {project === null ? "Every published artifact" : `Everything published to ${project.name}`}, newest first.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Tabs
          onValueChange={(value: ArtifactOwnerScope) => catalog.setOwnerScope(value)}
          value={catalog.ownerScope}
        >
          <TabsList variant="line">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="me">Yours</TabsTrigger>
            <TabsTrigger value="others">Shared with you</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <CatalogFilters
            commentFilter={catalog.commentFilter}
            knownTags={catalog.knownTags}
            onCommentFilterChange={catalog.setCommentFilter}
            onTagFiltersChange={catalog.setTagFilters}
            tagFilters={catalog.tagFilters}
          />
          <Select
            items={sortItems}
            onValueChange={(value: CatalogSort | null) => {
              if (value !== null) catalog.setSort(value);
            }}
            value={catalog.sort}
          >
            <SelectTrigger aria-label="Sort artifacts" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sortItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button
              aria-busy={refreshing === "loading"}
              aria-label="Refresh artifacts published by agents, the CLI, or other sessions"
              disabled={catalog.loading}
              onClick={() => void refresh()}
              size="sm"
              variant="ghost"
            >
              {refreshing === "complete" ? <IconCheck data-icon="inline-start" /> : <IconRefresh data-icon="inline-start" />}
              {refreshing === "loading" ? "Refreshing…" : refreshing === "complete" ? "Refreshed" : "Refresh"}
            </Button>
            <span aria-live="polite" className="sr-only">
              {refreshing === "loading" ? "Refreshing artifact catalog." : refreshing === "complete" ? "Artifact catalog refreshed." : ""}
            </span>
            <ToggleGroup
              aria-label="Layout"
              onValueChange={(value) => {
                const next = value[0];
                if (next === "grid" || next === "list") changeLayout(next);
              }}
              size="sm"
              value={[layout]}
              variant="outline"
            >
              <ToggleGroupItem aria-label="List" value="list">
                <IconList />
              </ToggleGroupItem>
              <ToggleGroupItem aria-label="Grid" value="grid">
                <IconLayoutGrid />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </div>

      {catalog.error === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>Catalog unavailable</AlertTitle>
          <AlertDescription>{catalog.error.message}</AlertDescription>
        </Alert>
      )}
      {catalog.loading && catalog.items.length === 0 ? <GallerySkeleton layout={layout} /> : null}
      {!catalog.loading && catalog.error === null && catalog.items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconStack2 /></EmptyMedia>
            <EmptyTitle aria-level={2} role="heading">
              {catalog.filtered
                ? "No matching artifacts"
                : catalog.ownerScope === "others" ? "Nothing shared with you yet" : "No artifacts yet"}
            </EmptyTitle>
            <EmptyDescription>
              {catalog.filtered
                ? "Try clearing a filter or using a wider search."
                : "Publish from the CLI or a connected agent to populate this project."}
            </EmptyDescription>
          </EmptyHeader>
          {catalog.filtered ? (
            <EmptyContent>
              <Button
                onClick={() => {
                  catalog.setQuery("");
                  catalog.setCommentFilter("all");
                  catalog.setTagFilters([]);
                }}
                size="sm"
                variant="outline"
              >
                Clear filters
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {groups.map((group) => (
        <section aria-labelledby={`gallery-day-${group.key}`} className="flex flex-col gap-2" key={group.key}>
          <h2 className="text-xs font-medium text-muted-foreground" id={`gallery-day-${group.key}`}>{group.label}</h2>
          <ul className={cn(
            layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3" : "flex flex-col divide-y rounded-xl border",
          )}>
            {group.items.map((item) => (
              <li className="min-w-0" key={item.artifact.id}>
                <ArtifactEntry
                  canManage={permissions.canManageArtifacts}
                  href={artifactHref(projectId, item)}
                  item={item}
                  layout={layout}
                  now={now}
                  onAction={(action) => void act(action, item)}
                  viewerPrincipalId={session.principal.id}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {catalog.nextCursor === null ? null : (
        <Button className="self-center" disabled={catalog.loading} onClick={catalog.loadMore} variant="outline">
          {catalog.loading ? "Loading…" : "Load more"}
        </Button>
      )}

      {pending === null ? null : (
        <>
          <RenameArtifactDialog
            artifact={pending.details.artifact}
            onDone={(result) => {
              setPending(null);
              catalog.updateArtifact({...pending.details.artifact, name: result.artifact.name});
            }}
            onOpenChange={closeDialog}
            open={pending.action === "rename"}
            projectId={projectId}
            version={pending.details.current}
          />
          <DuplicateArtifactDialog
            artifact={pending.details.artifact}
            onDone={onDuplicated}
            onOpenChange={closeDialog}
            open={pending.action === "duplicate"}
            projectId={projectId}
            version={pending.details.current}
          />
          <DeleteArtifactDialog
            artifact={pending.details.artifact}
            onConfirm={async () => {
              try {
                await api.deleteArtifact(
                  projectId,
                  pending.details.artifact.id,
                  pending.details.artifact.currentVersionId,
                  crypto.randomUUID(),
                );
                catalog.removeArtifact(pending.details.artifact.id);
                toast.success(`Deleted ${pending.details.artifact.name}`);
                return true;
              } catch (caught) {
                toast.error(caught instanceof Error ? caught.message : "Artifact deletion failed.");
                return false;
              }
            }}
            onOpenChange={closeDialog}
            open={pending.action === "delete"}
          />
        </>
      )}
    </div>
  );
}

/** One artifact as a list row or a grid card; the whole surface opens it. */
function ArtifactEntry({
  canManage,
  href,
  item,
  layout,
  now,
  onAction,
  viewerPrincipalId,
}: {
  readonly canManage: boolean;
  readonly href: string;
  readonly item: CatalogItem;
  readonly layout: GalleryLayout;
  readonly now: Date;
  readonly onAction: (action: ArtifactItemAction) => void;
  readonly viewerPrincipalId: string;
}) {
  const {artifact, commentCount, owner, updatedAt, versionCount, views} = item;
  const meta = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <OwnerHoverCard identity={owner} viewerPrincipalId={viewerPrincipalId}>
        <OwnerAvatar className="size-5 text-[0.6rem]" identity={owner} />
        {principalLabel(owner, viewerPrincipalId)}
      </OwnerHoverCard>
      <span aria-hidden="true">·</span>
      <time dateTime={updatedAt} title={new Date(updatedAt).toLocaleString()}>Edited {relativeTime(updatedAt, now)}</time>
      <span aria-hidden="true">·</span>
      <span>{versionCount} version{versionCount === 1 ? "" : "s"}</span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <IconMessage aria-hidden="true" className="size-3.5" />
        {commentCount} comment{commentCount === 1 ? "" : "s"}
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1" title={`${views.total} total views`}>
        <IconEye aria-hidden="true" className="size-3.5" />
        {views.last30Days} view{views.last30Days === 1 ? "" : "s"} in 30 days
      </span>
    </span>
  );
  const badges = (
    <span className="flex flex-wrap items-center gap-1">
      <AccessBadge access={artifact.accessSetting} />
      {artifact.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
    </span>
  );
  const menu = <ArtifactItemMenu canManage={canManage} name={artifact.name} onAction={onAction} />;

  if (layout === "grid") {
    return (
      <div className="group/entry relative flex h-full flex-col gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/50">
        <div className="flex aspect-[16/9] items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <IconFileText aria-hidden="true" className="size-8" />
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <a className="min-w-0 flex-1 truncate text-sm font-medium after:absolute after:inset-0" href={href}>
            {artifact.name}
          </a>
          <div className="relative">{menu}</div>
        </div>
        {badges}
        {meta}
      </div>
    );
  }
  return (
    <div className="group/entry relative flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <IconFileText className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <a className="truncate text-sm font-medium after:absolute after:inset-0" href={href}>{artifact.name}</a>
          <span className="hidden sm:flex">{badges}</span>
        </span>
        {meta}
      </div>
      <div className="relative">{menu}</div>
    </div>
  );
}

function GallerySkeleton({layout}: {readonly layout: GalleryLayout}) {
  const rows = [0, 1, 2, 3];
  return (
    <div aria-busy="true" className={layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3" : "flex flex-col gap-2"}>
      <span className="sr-only">Loading artifacts</span>
      {rows.map((row) => (
        <Skeleton className={layout === "grid" ? "h-52 rounded-xl" : "h-14 rounded-lg"} key={row} />
      ))}
    </div>
  );
}
