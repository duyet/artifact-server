import {
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import {useRef, useState, type KeyboardEvent} from "react";
import {Bar, BarChart, CartesianGrid, XAxis} from "recharts";

import {ThemeMenu} from "@/components/theme-menu";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Badge} from "@/components/ui/badge";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";

import {
  buildPublicArtifactTree,
  densifyDailySeries,
  entriesOnDay,
  sparklineBars,
  sparklineBox,
  sumDailySeries,
  windowDays,
  type DailyMetric,
  type PublicArtifactTreeEntry,
  type PublicArtifactTreeFolder,
} from "./home-tree.js";
import type {PublicCatalog} from "./home-client.js";

/** The copy each chart measure brings to the card and the tree filter. */
const dailyCharts = {
  updates: {
    description: "Versions published across every public artifact.",
    filter: "Updated on",
    title: "Updated per day",
    toggle: "Updated",
    unit: ["version", "versions"],
  },
  views: {
    description: "Across every public artifact.",
    filter: "Viewed on",
    title: "Views per day",
    toggle: "Views",
    unit: ["view", "views"],
  },
} as const satisfies Record<DailyMetric, {
  readonly description: string;
  readonly filter: string;
  readonly title: string;
  readonly toggle: string;
  readonly unit: readonly [string, string];
}>;

/** The chart's measure and the one day, if any, that filters the tree. */
interface DayFilter {
  readonly day: string | null;
  readonly metric: DailyMetric;
}

/**
 * The home page. Every colour is a semantic token, so the application's theme
 * reaches this page without an edit here.
 */
export function HomePage({catalog}: {readonly catalog: PublicCatalog}) {
  const now = Date.now();
  const days = windowDays(todayUtc(), catalog.windowDays);
  const [filter, setFilter] = useState<DayFilter>({day: null, metric: "views"});
  const chartRef = useRef<HTMLDivElement>(null);
  const shown = filter.day === null
    ? catalog.artifacts
    : entriesOnDay(catalog.artifacts, filter.metric, filter.day);
  const tree = buildPublicArtifactTree(shown);
  // A filtered tree opens every folder, so a match never hides in a
  // collapsed one.
  const collapsed = new Set(filter.day === null ? catalog.collapsedFolders : []);
  const filterVerb = dailyCharts[filter.metric].filter;
  const filterDay = filter.day === null ? null : formatDay(filter.day);
  const clearFilter = () => {
    const day = filter.day;
    setFilter({day: null, metric: filter.metric});
    // The chip that held focus is gone, so focus returns to the day it named.
    if (day !== null) focusDayButton(chartRef.current, day);
  };
  const totals = catalog.artifacts.reduce(
    (sum, artifact) => ({
      last7Days: sum.last7Days + artifact.views.last7Days,
      last30Days: sum.last30Days + artifact.views.last30Days,
      total: sum.total + artifact.views.total,
    }),
    {last7Days: 0, last30Days: 0, total: 0},
  );

  return (
    // One `main` landmark, so a screen reader can jump past the heading and
    // straight to the catalog.
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Artifact Server
          </h1>
          <p className="text-sm text-muted-foreground">
            {artifactCount(catalog.artifacts.length)}
          </p>
        </div>
        <nav aria-label="Primary" className="flex items-center gap-2">
          <ButtonLink href="/review" variant="outline">Workbench</ButtonLink>
          <ThemeMenu />
        </nav>
      </header>

      <section aria-labelledby="home-totals" className="grid grid-cols-3 gap-4">
        <h2 className="sr-only" id="home-totals">View totals</h2>
        <TotalCard label="Last 7 days" value={totals.last7Days} />
        <TotalCard label="Last 30 days" value={totals.last30Days} />
        <TotalCard label="All time" value={totals.total} />
      </section>

      <DailyChart
        days={days}
        filter={filter}
        onFilterChange={setFilter}
        ref={chartRef}
        values={densifyDailySeries(
          sumDailySeries(catalog.artifacts, filter.metric),
          days,
        )}
      />

      {catalog.truncated
        ? (
          <Alert>
            <IconInfoCircle />
            <AlertDescription>
              This installation holds more public artifacts than this page shows.
            </AlertDescription>
          </Alert>
        )
        : null}

      {catalog.artifacts.length === 0
        ? <EmptyCatalog />
        : (
          <Card>
            <CardHeader>
              <CardTitle>Artifacts</CardTitle>
              <CardDescription aria-live="polite">
                {filterDay === null
                  ? "Shared by link, newest first."
                  : `${artifactCount(shown.length)} ${filterVerb.toLowerCase()} ${filterDay}.`}
              </CardDescription>
              {filterDay === null ? null : (
                <CardAction>
                  <Button
                    aria-label={`${filterVerb} ${filterDay}, clear`}
                    onClick={clearFilter}
                    size="sm"
                    variant="secondary"
                  >
                    {filterVerb} {filterDay}
                    <IconX data-icon="inline-end" />
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent
              className="flex flex-col gap-1"
              // A new day remounts the folders, so each starts in its default
              // state again rather than where the last filter left it.
              key={filter.day ?? ""}
            >
              {tree.folders.map((folder) => (
                <FolderNode
                  key={folder.path}
                  collapsed={collapsed}
                  days={days}
                  folder={folder}
                  now={now}
                />
              ))}
              {tree.ungrouped.length === 0 ? null : (
                <TreeFolder id="home-ungrouped" name="Without a path">
                  {tree.ungrouped.map((artifact) => (
                    <ArtifactNode
                      key={artifact.url}
                      artifact={artifact}
                      days={days}
                      now={now}
                    />
                  ))}
                </TreeFolder>
              )}
            </CardContent>
          </Card>
        )}
    </main>
  );
}

function EmptyCatalog() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><IconFolderOpen /></EmptyMedia>
        <EmptyTitle>Nothing published yet</EmptyTitle>
        <EmptyDescription>
          No artifact on this server is shared by link. Publish one with a public
          link and it appears here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function TotalCard({label, value}: {readonly label: string; readonly value: number}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{formatCount(value)}</CardTitle>
      </CardHeader>
    </Card>
  );
}

/** No inset, so each day's band spans exactly 1/n of the chart's width. */
const dailyChartMargin = {bottom: 0, left: 0, right: 0, top: 4};

/**
 * One bar per day, summed across every public artifact, in the chosen measure.
 * Clicking a day's column, or pressing a day's button, filters the tree to it.
 */
function DailyChart({
  days,
  filter,
  onFilterChange,
  ref,
  values,
}: {
  readonly days: readonly string[];
  readonly filter: DayFilter;
  readonly onFilterChange: (next: DayFilter) => void;
  readonly ref: React.Ref<HTMLDivElement>;
  readonly values: readonly number[];
}) {
  const chart = dailyCharts[filter.metric];
  const data = days.map((day, index) => ({count: values[index] ?? 0, day}));
  // One day is the tab stop and the arrow keys move between the rest, so the
  // chart costs a keyboard reader one Tab, not one per day.
  const tabStop = filter.day ?? data.findLast((row) => row.count > 0)?.day;
  const config = {
    count: {color: "var(--muted-foreground)", label: capitalize(chart.unit[1])},
  } satisfies ChartConfig;
  // A day with no count filters to an empty tree, so it is not a target.
  const toggleDay = (day: string) => {
    if (!data.some((row) => row.day === day && row.count > 0)) return;
    onFilterChange({day: filter.day === day ? null : day, metric: filter.metric});
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{chart.title}</CardTitle>
        <CardDescription>{chart.description}</CardDescription>
        <CardAction>
          <ToggleGroup
            aria-label="Chart measure"
            onValueChange={(value) => {
              const next = value[0];
              // A day means something else in the other measure, so it clears.
              if (next === "updates" || next === "views") {
                onFilterChange({day: null, metric: next});
              }
            }}
            size="sm"
            value={[filter.metric]}
            variant="outline"
          >
            <ToggleGroupItem value="views">{dailyCharts.views.toggle}</ToggleGroupItem>
            <ToggleGroupItem value="updates">{dailyCharts.updates.toggle}</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="relative" ref={ref}>
          <ChartContainer className="aspect-auto h-32 w-full cursor-pointer" config={config}>
            <BarChart
              data={data}
              margin={dailyChartMargin}
              onClick={(state) => {
                const row = data.find((item) => item.day === state.activeLabel);
                if (row !== undefined) toggleDay(row.day);
              }}
            >
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" hide />
              <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                isAnimationActive={false}
                radius={2}
              />
            </BarChart>
          </ChartContainer>
          {/*
            The keyboard path: one button per day laid over its column. They
            let the pointer through, so hovering still reaches the tooltip and
            a click lands on the chart's own handler.
          */}
          <div
            aria-label={chart.title}
            className="pointer-events-none absolute inset-0 grid"
            role="group"
            style={{gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))`}}
          >
            {data.map((row) => row.count === 0
              ? <span key={row.day} />
              : (
                <button
                  aria-label={`${formatDay(row.day)}: ${formatCount(row.count)} ${
                    chart.unit[row.count === 1 ? 0 : 1]
                  }`}
                  aria-pressed={filter.day === row.day}
                  className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-foreground/10"
                  data-day={row.day}
                  key={row.day}
                  onClick={() => {
                    toggleDay(row.day);
                  }}
                  onKeyDown={moveBetweenDays}
                  tabIndex={row.day === tabStop ? 0 : -1}
                  type="button"
                />
              ))}
          </div>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{days[0] ?? ""}</span>
          <span>{days[days.length - 1] ?? ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Arrow keys, Home, and End move focus along a chart's day buttons. */
function moveBetweenDays(event: KeyboardEvent<HTMLButtonElement>): void {
  const buttons = [
    ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[data-day]") ?? []),
  ];
  const index = buttons.indexOf(event.currentTarget);
  const target = {
    ArrowLeft: buttons[index - 1],
    ArrowRight: buttons[index + 1],
    End: buttons.at(-1),
    Home: buttons[0],
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
}

/** Move keyboard focus to one day's button inside a chart. */
function focusDayButton(chart: HTMLElement | null, day: string): void {
  chart?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
}

/**
 * A folder row in the file-tree pattern: a Collapsible whose trigger is a
 * Button. The row is a heading so a reader can jump between folders.
 */
function TreeFolder({
  children,
  defaultOpen = true,
  id,
  name,
  prefix = "",
}: {
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly id: string;
  readonly name: string;
  /** The path above `name`, spoken but not drawn: the indent already shows it. */
  readonly prefix?: string;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <h2 id={id}>
        <CollapsibleTrigger
          // One name for the whole path: a visually hidden prefix element
          // would be read as a separate word ("2026/ 10").
          aria-label={prefix + name}
          render={
            <Button
              className="w-full justify-start font-normal aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50"
              size="sm"
              variant="ghost"
            />
          }
        >
          <IconChevronRight className="transition-transform group-data-panel-open/button:rotate-90" />
          <IconFolder />
          {name}
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>
        <div className="ml-4 flex flex-col border-l pl-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FolderNode({
  collapsed,
  days,
  folder,
  now,
}: {
  readonly collapsed: ReadonlySet<string>;
  readonly days: readonly string[];
  readonly folder: PublicArtifactTreeFolder;
  readonly now: number;
}) {
  return (
    <TreeFolder
      defaultOpen={!collapsed.has(folder.path)}
      id={`folder-${folder.path}`}
      name={folder.label}
      prefix={folder.path.slice(0, folder.path.length - folder.label.length)}
    >
      {folder.artifacts.map((artifact) => (
        <ArtifactNode key={artifact.url} artifact={artifact} days={days} now={now} />
      ))}
      {folder.folders.map((child) => (
        <FolderNode
          key={child.path}
          collapsed={collapsed}
          days={days}
          folder={child}
          now={now}
        />
      ))}
    </TreeFolder>
  );
}

function ArtifactNode({
  artifact,
  days,
  now,
}: {
  readonly artifact: PublicArtifactTreeEntry;
  readonly days: readonly string[];
  readonly now: number;
}) {
  const counts = densifyDailySeries(artifact.series, days);
  const bars = sparklineBars(counts, sparklineBox);
  return (
    <div className="flex items-center gap-3 rounded-lg pr-2 hover:bg-muted/50">
      <ButtonLink
        className="min-w-0 flex-1 justify-start font-normal"
        href={artifact.url}
        size="sm"
        variant="ghost"
      >
        <IconFileText />
        <span className="truncate">{artifact.name}</span>
      </ButtonLink>
      <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
        {artifact.views.last7Days} / 7d
      </span>
      <span className="sr-only">
        {`${artifact.views.last30Days} views over ${counts.length} days, ` +
          `${artifact.views.total} in all`}
      </span>
      <span className="hidden shrink-0 sm:block">
        <svg
          aria-hidden="true"
          className="block text-muted-foreground"
          height={sparklineBox.height}
          role="presentation"
          viewBox={`0 0 ${sparklineBox.width} ${sparklineBox.height}`}
          width={sparklineBox.width}
        >
          {bars.map((bar, index) => (
            <rect
              className="fill-current"
              height={bar.height}
              key={days[index]}
              width={bar.width}
              x={bar.x}
              y={sparklineBox.height - bar.height}
            />
          ))}
        </svg>
      </span>
      <Badge className="tabular-nums" variant="secondary">
        {formatCount(artifact.views.total)}
      </Badge>
      <time
        className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block"
        dateTime={artifact.updatedAt}
      >
        {formatUpdated(artifact.updatedAt, now)}
      </time>
    </div>
  );
}

/** "26 Oct" for a stored UTC day. */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The current UTC day, which is the day the stored counters are bucketed on. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function artifactCount(count: number): string {
  return count === 1 ? "1 public artifact" : `${formatCount(count)} public artifacts`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUpdated(value: string, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const elapsedDays = Math.round((now - date.getTime()) / 86_400_000);
  if (elapsedDays <= 0) return "today";
  if (elapsedDays === 1) return "yesterday";
  if (elapsedDays < 30) return `${elapsedDays} days ago`;
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium"}).format(date);
}
