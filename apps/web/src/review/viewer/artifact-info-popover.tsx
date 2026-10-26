import {Popover as PopoverPrimitive} from "@base-ui/react/popover";
import {IconInfoCircle} from "@tabler/icons-react";

import type {ArtifactInfo, ArtifactOwner} from "@/api/client";
import {Sparkline} from "@/components/sparkline";
import {Button} from "@/components/ui/button";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {Spinner} from "@/components/ui/spinner";
import {formatTimestamp} from "@/lib/presentation";
import type {Visibility} from "@/lib/visibility";
import {VisibilityBadge, visibilityPresentation} from "../access-badge.tsx";
import {relativeTime} from "../catalog/catalog-time.ts";
import {OwnerAvatar} from "../owner-avatar.tsx";
import {OwnerHoverCard} from "../owner-hover-card.tsx";
import type {ArtifactInfoState} from "./use-artifact-info.ts";

const visibilityOptions = (["public", "unlisted", "private"] as const).map((value) => ({
  label: visibilityPresentation[value].label,
  value,
}));

/** The (i) button: who made the artifact, which version, who can open it, and its views. */
export function ArtifactInfoPopover({
  owner,
  state,
  viewerPrincipalId,
}: {
  /** The owner record behind the hover card; null until details load. */
  readonly owner: ArtifactOwner | null;
  readonly state: ArtifactInfoState;
  readonly viewerPrincipalId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button aria-label="Artifact info" size="icon-sm" variant="ghost" />}>
        <IconInfoCircle />
      </PopoverTrigger>
      {/* Base UI cannot see clicks inside the artifact iframe; the backdrop makes outside-press work over it. */}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Backdrop className="fixed inset-0 isolate z-50" />
      </PopoverPrimitive.Portal>
      <PopoverContent align="start" aria-label="Artifact info" className="w-72 p-3" sideOffset={8}>
        {state.info === null ? (
          state.loadError === null ? (
            <Spinner aria-label="Reading artifact info" className="self-center" />
          ) : (
            <p className="text-sm text-destructive" role="alert">{state.loadError}</p>
          )
        ) : (
          <InfoRows owner={owner} state={state} info={state.info} viewerPrincipalId={viewerPrincipalId} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function InfoRows({
  info,
  owner,
  state,
  viewerPrincipalId,
}: {
  readonly info: ArtifactInfo;
  readonly owner: ArtifactOwner | null;
  readonly state: ArtifactInfoState;
  readonly viewerPrincipalId: string;
}) {
  const author = info.owner.displayName ?? "Unknown";
  const visibility = state.visibility ?? info.visibility;
  const values = lastDays(info.views.daily, info.windowDays);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-sm">
      <dt className="text-muted-foreground">Author</dt>
      <dd className="min-w-0">
        {owner === null ? author : (
          <OwnerHoverCard identity={owner} viewerPrincipalId={viewerPrincipalId}>
            <OwnerAvatar identity={owner} />
            <span className="truncate">{author}</span>
          </OwnerHoverCard>
        )}
      </dd>
      <dt className="text-muted-foreground">Version</dt>
      <dd className="tabular-nums">v{info.version.number}</dd>
      <dt className="text-muted-foreground">Visibility</dt>
      <dd className="flex min-w-0 flex-col items-start gap-1">
        {info.canManage ? (
          <VisibilitySelect
            onChange={(target) => void state.changeVisibility(target)}
            pending={state.pendingVisibility}
            value={visibility}
          />
        ) : (
          <VisibilityBadge visibility={visibility} />
        )}
        {state.changeError === null ? null : (
          <p className="text-xs text-destructive" role="alert">{state.changeError}</p>
        )}
      </dd>
      <dt className="text-muted-foreground">Updated</dt>
      <dd>
        <time dateTime={info.updatedAt} title={formatTimestamp(info.updatedAt)}>
          {relativeTime(info.updatedAt, new Date())}
        </time>
      </dd>
      <dt className="text-muted-foreground">Views</dt>
      <dd className="flex items-center gap-2">
        <Sparkline
          label={`${info.views.last30Days} ${info.views.last30Days === 1 ? "view" : "views"} in the last ${info.windowDays} days, ${info.views.total} in all`}
          values={values}
        />
        <span className="tabular-nums">{info.views.total}</span>
      </dd>
    </dl>
  );
}

function VisibilitySelect({
  onChange,
  pending,
  value,
}: {
  readonly onChange: (target: Visibility) => void;
  readonly pending: Visibility | null;
  readonly value: Visibility;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        disabled={pending !== null}
        items={visibilityOptions}
        onValueChange={(next) => {
          if (next !== null && next !== value) onChange(next);
        }}
        value={pending ?? value}
      >
        <SelectTrigger aria-label="Visibility" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {visibilityOptions.map((option) => {
              const OptionIcon = visibilityPresentation[option.value].icon;
              return (
                <SelectItem key={option.value} value={option.value}>
                  <OptionIcon />
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
      {pending === null ? null : <Spinner aria-label="Changing visibility" />}
    </div>
  );
}

/**
 * One count per day of the window, oldest first and ending today in UTC, the
 * zone the server counts days in. Days the sparse series leaves out are zero.
 */
function lastDays(
  daily: ArtifactInfo["views"]["daily"],
  windowDays: number,
): readonly number[] {
  const counts = new Map(daily.map((row) => [row.day, row.views]));
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Array.from({length: windowDays}, (_, index) => {
    const day = new Date(today - (windowDays - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return counts.get(day) ?? 0;
  });
}
