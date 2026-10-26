import {
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import {useRef, useState, type KeyboardEvent} from "react";
import {Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis} from "recharts";

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
import {ChartContainer, type ChartConfig} from "@/components/ui/chart";
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
import {NativeSelect, NativeSelectOption} from "@/components/ui/native-select";
import {Toggle} from "@/components/ui/toggle";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";

import {
  buildPublicArtifactTree,
  busiestDay,
  dayTone,
  densifyDailySeries,
  entriesOnDay,
  sparklineBars,
  sparklineBox,
  sumDailySeries,
  treeSorts,
  windowDays,
  type DailyMetric,
  type DayTone,
  type PublicArtifactTreeEntry,
  type PublicArtifactTreeFolder,
  type TreeSort,
} from "./home-tree.js";
import type {PublicCatalog} from "./home-client.js";
import {ArtifactRowMenu, visibilityLabels} from "./home-row-menu.js";

/** The copy each chart measure brings to the card and the tree filter. */
const dailyCharts = {
  updates: {
    color: "var(--chart-updates)",
    description: "Versions published across every artifact listed below.",
    filter: "Updated on",
    title: "Updated per day",
    toggle: "Updated",
    unit: ["version", "versions"],
  },
  views: {
    color: "var(--chart-views)",
    description: "Across every artifact listed below.",
    filter: "Viewed on",
    title: "Views per day",
    toggle: "Views",
    unit: ["view", "views"],
  },
} as const satisfies Record<DailyMetric, {
  /** The measure's accent, a theme token validated for contrast and CVD. */
  readonly color: string;
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

/** The words each tree order shows in the sort control and the description. */
const treeSortLabels = {
  name: {description: "by name", option: "Name"},
  updated: {description: "newest first", option: "Last updated"},
  views: {description: "most viewed first", option: "Most viewed"},
} as const satisfies Record<TreeSort, {readonly description: string; readonly option: string}>;

/** Where this browser remembers the reader's tree order. */
const treeSortStorageKey = "artifact-server-home-sort";

/**
 * The order this browser last chose. Storage can be missing or refuse access
 * in a private window, and the page then starts newest first.
 */
function storedTreeSort(): TreeSort {
  try {
    const stored = window.localStorage.getItem(treeSortStorageKey);
    return treeSorts.find((sort) => sort === stored) ?? "updated";
  } catch {
    return "updated";
  }
}

function storeTreeSort(sort: TreeSort): void {
  try {
    window.localStorage.setItem(treeSortStorageKey, sort);
  } catch {
    // The choice still applies to this page; it is only not remembered.
  }
}

/** What every artifact row needs besides its own artifact. */
interface RowContext {
  readonly days: readonly string[];
  readonly now: number;
  readonly onChanged: () => void;
  /** True when the viewer is signed in, so rows keep a column for the menu. */
  readonly signedIn: boolean;
}

/**
 * The home page. Every colour is a semantic token, so the application's theme
 * reaches this page without an edit here.
 */
export function HomePage({
  catalog,
  onChanged,
}: {
  readonly catalog: PublicCatalog;
  /** Read the catalog again after this page changed an artifact. */
  readonly onChanged: () => void;
}) {
  const now = Date.now();
  const days = windowDays(todayUtc(), catalog.windowDays);
  const [filter, setFilter] = useState<DayFilter>({day: null, metric: "views"});
  const [sort, setSort] = useState<TreeSort>(storedTreeSort);
  // The account menu's "My artifacts" opens the page with `?mine=1`.
  const [mineOnly, setMineOnly] = useState(
    () => new URLSearchParams(window.location.search).get("mine") === "1",
  );
  const signedIn = catalog.viewer !== null;
  const chartRef = useRef<HTMLDivElement>(null);
  const onDay = filter.day === null
    ? catalog.artifacts
    : entriesOnDay(catalog.artifacts, filter.metric, filter.day);
  const shown = signedIn && mineOnly ? onDay.filter((artifact) => artifact.mine) : onDay;
  const tree = buildPublicArtifactTree(shown, sort);
  const row: RowContext = {days, now, onChanged, signedIn};
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
            {artifactCount(catalog.artifacts.length, signedIn)}
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
              This installation holds more artifacts than this page shows.
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
                  ? `${treeScope(signedIn, mineOnly)}, ${treeSortLabels[sort].description}.`
                  : `${artifactCount(shown.length, signedIn)} ${filterVerb.toLowerCase()} ${filterDay}.`}
              </CardDescription>
              <CardAction className="flex flex-wrap items-center justify-end gap-2">
                {filterDay === null ? null : (
                  <Button
                    aria-label={`${filterVerb} ${filterDay}, clear`}
                    onClick={clearFilter}
                    size="sm"
                    variant="secondary"
                  >
                    {filterVerb} {filterDay}
                    <IconX data-icon="inline-end" />
                  </Button>
                )}
                {signedIn
                  ? (
                    <Toggle
                      onPressedChange={setMineOnly}
                      pressed={mineOnly}
                      size="sm"
                      variant="outline"
                    >
                      Mine
                    </Toggle>
                  )
                  : null}
                <NativeSelect
                  aria-label="Sort artifacts"
                  onChange={(event) => {
                    const next = treeSorts.find((value) => value === event.target.value);
                    if (next === undefined) return;
                    setSort(next);
                    storeTreeSort(next);
                  }}
                  size="sm"
                  value={sort}
                >
                  {treeSorts.map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {treeSortLabels[value].option}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </CardAction>
            </CardHeader>
            <CardContent
              className="flex flex-col gap-1"
              // A new day remounts the folders, so each starts in its default
              // state again rather than where the last filter left it.
              key={filter.day ?? ""}
            >
              {mineOnly && shown.length === 0
                ? <p className="px-2 py-4 text-sm text-muted-foreground">You own no artifact here yet.</p>
                : null}
              {tree.folders.map((folder) => (
                <FolderNode
                  key={folder.path}
                  collapsed={collapsed}
                  folder={folder}
                  row={row}
                />
              ))}
              {tree.ungrouped.length === 0 ? null : (
                <TreeFolder id="home-ungrouped" name="Without a path">
                  {tree.ungrouped.map((artifact) => (
                    <ArtifactNode key={artifact.url} artifact={artifact} row={row} />
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

/** The day the tooltip names, and whether the pointer or the keyboard chose it. */
interface ActiveDay {
  readonly day: string;
  readonly source: "focus" | "pointer";
}

/** No inset, so each day's band spans exactly 1/n of the chart's width. */
const dailyChartMargin = {bottom: 0, left: 0, right: 0, top: 8};

/**
 * Each tone mixes the measure's accent into the card. The two tints were
 * checked against the card: the lightest still clears 3:1 (WCAG 1.4.11) in
 * both themes, and each step sits a visible lightness gap apart.
 */
const toneFill = {
  full: "var(--color-count)",
  hover: "color-mix(in oklab, var(--color-count) 90%, var(--card))",
  muted: "color-mix(in oklab, var(--color-count) 80%, var(--card))",
} as const satisfies Record<DayTone, string>;

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
  // The latest input wins, so a mouse resting on the chart never hides the
  // day a keyboard reader just moved to.
  const [active, setActive] = useState<ActiveDay | null>(null);
  const activeDay = active?.day ?? null;
  const pressedDay = useRef<string | null>(null);
  const release = (source: ActiveDay["source"]) => {
    setActive((current) => (current?.source === source ? null : current));
  };
  const activeIndex = data.findIndex((row) => row.day === activeDay);
  const today = days.at(-1);
  const total = values.reduce((sum, value) => sum + value, 0);
  const busiest = busiestDay(values, days);
  // One day is the tab stop and the arrow keys move between the rest, so the
  // chart costs a keyboard reader one Tab, not one per day.
  const tabStop = filter.day ?? data.findLast((row) => row.count > 0)?.day;
  const config = {
    count: {color: chart.color, label: capitalize(chart.unit[1])},
  } satisfies ChartConfig;
  const unit = (count: number) => chart.unit[count === 1 ? 0 : 1];
  // A day with no count filters to an empty tree, so it is not a target.
  const toggleDay = (day: string) => {
    if (!data.some((row) => row.day === day && row.count > 0)) return;
    onFilterChange({day: filter.day === day ? null : day, metric: filter.metric});
  };
  // The column under the pointer, from the same equal split the buttons use.
  const dayAt = (event: React.PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return data[Math.floor(((event.clientX - box.left) / box.width) * data.length)]?.day ?? null;
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
        <p className="text-sm text-muted-foreground" data-slot="chart-summary">
          <span className="font-medium text-foreground tabular-nums">{formatCount(total)}</span>
          {` ${unit(total)} in ${days.length} days`}
          {busiest === null
            ? null
            : `, busiest on ${formatDay(busiest.day)} with ${formatCount(busiest.count)}`}
        </p>
        <div className="relative" ref={ref}>
          <ChartContainer
            // The mirrored tick labels sit over the first columns, so they
            // must not take the pointer from the bars.
            className="aspect-auto h-32 w-full cursor-pointer [&_.recharts-yAxis]:pointer-events-none"
            config={config}
            // A press and release on one column toggles it. Recharts remounts
            // every bar when a tone changes, so the bar pressed on hover can be
            // gone before the release and the browser then sends no click.
            onPointerDown={(event) => {
              pressedDay.current = event.button === 0 ? dayAt(event) : null;
            }}
            onPointerUp={(event) => {
              const day = dayAt(event);
              if (day !== null && day === pressedDay.current) toggleDay(day);
              pressedDay.current = null;
            }}
            onPointerCancel={() => {
              pressedDay.current = null;
            }}
            onPointerLeave={() => {
              release("pointer");
            }}
            onPointerMove={(event) => {
              const day = dayAt(event);
              if (day !== null && day !== activeDay) setActive({day, source: "pointer"});
            }}
          >
            <BarChart data={data} margin={dailyChartMargin}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" hide />
              {/* Mirrored, so the ticks sit inside the plot and take no width. */}
              <YAxis
                allowDecimals={false}
                axisLine={false}
                mirror
                tick={{fontSize: 10}}
                tickCount={3}
                tickLine={false}
              />
              {/*
                One Cell per day carries its tone. Recharts 3 deprecates Cell
                for a custom bar renderer, but that prop's name trips the
                repository's anti-slop symbol rule.
              */}
              <Bar dataKey="count" isAnimationActive={false} radius={2}>
                {data.map((row) => (
                  <Cell
                    fill={toneFill[dayTone(row.day, filter.day, activeDay)]}
                    key={row.day}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          {/*
            The keyboard path: one button per day laid over its column. They
            let the pointer through, so a click lands on the chart's handler
            above.
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
                  aria-label={`${formatDay(row.day)}: ${formatCount(row.count)} ${unit(row.count)}`}
                  aria-pressed={filter.day === row.day}
                  className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  data-day={row.day}
                  key={row.day}
                  onBlur={() => {
                    release("focus");
                  }}
                  onClick={() => {
                    toggleDay(row.day);
                  }}
                  onFocus={(event) => {
                    // Only a keyboard focus shows the tooltip. The chip hands
                    // focus back to its day after a mouse click too, and that
                    // reader already sees the bar under the pointer.
                    if (event.currentTarget.matches(":focus-visible")) {
                      setActive({day: row.day, source: "focus"});
                    }
                  }}
                  onKeyDown={moveBetweenDays}
                  tabIndex={row.day === tabStop ? 0 : -1}
                  type="button"
                />
              ))}
          </div>
          {activeIndex === -1 ? null : (
            <DayTooltip
              count={data[activeIndex]?.count ?? 0}
              day={data[activeIndex]?.day ?? ""}
              column={{index: activeIndex, of: data.length}}
              today={data[activeIndex]?.day === today}
              unit={unit(data[activeIndex]?.count ?? 0)}
            />
          )}
        </div>
        {/* Today's column carries a dot, so the newest bar reads as today. */}
        <div
          aria-hidden="true"
          className="grid"
          style={{gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))`}}
        >
          {data.map((row) => (
            <span className="flex justify-center" key={row.day}>
              {row.day === today
                ? <span className="size-1 rounded-full bg-foreground" data-slot="chart-today" />
                : null}
            </span>
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{days[0] === undefined ? "" : formatDay(days[0])}</span>
          <span>Today</span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The date and count of the day under the pointer or keyboard focus. It sits
 * at the top of the plot beside its column, on the side with more room, so it
 * never covers the column it names or the card header.
 */
function DayTooltip({
  column,
  count,
  day,
  today,
  unit,
}: {
  readonly column: {readonly index: number; readonly of: number};
  readonly count: number;
  readonly day: string;
  readonly today: boolean;
  readonly unit: string;
}) {
  const leftHalf = column.index < column.of / 2;
  const edge = ((leftHalf ? column.index + 1 : column.index) / column.of) * 100;
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 flex w-max flex-col rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-sm"
      aria-hidden="true"
      data-slot="chart-tooltip"
      style={leftHalf
        ? {left: `calc(${edge}% + 6px)`}
        : {left: `calc(${edge}% - 6px)`, transform: "translateX(-100%)"}}
    >
      <span className="font-medium">{today ? `Today, ${formatDay(day)}` : formatDay(day)}</span>
      <span className="text-muted-foreground tabular-nums">{`${formatCount(count)} ${unit}`}</span>
    </div>
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
  folder,
  row,
}: {
  readonly collapsed: ReadonlySet<string>;
  readonly folder: PublicArtifactTreeFolder;
  readonly row: RowContext;
}) {
  return (
    <TreeFolder
      defaultOpen={!collapsed.has(folder.path)}
      id={`folder-${folder.path}`}
      name={folder.label}
      prefix={folder.path.slice(0, folder.path.length - folder.label.length)}
    >
      {folder.artifacts.map((artifact) => (
        <ArtifactNode key={artifact.url} artifact={artifact} row={row} />
      ))}
      {folder.folders.map((child) => (
        <FolderNode key={child.path} collapsed={collapsed} folder={child} row={row} />
      ))}
    </TreeFolder>
  );
}

/**
 * One artifact row: its name, owner, a 30-day sparkline whose tooltip and
 * accessible name carry the exact counts, when it last changed, and, when the
 * viewer may change it, the row menu.
 */
function ArtifactNode({
  artifact,
  row,
}: {
  readonly artifact: PublicArtifactTreeEntry;
  readonly row: RowContext;
}) {
  const counts = densifyDailySeries(artifact.series, row.days);
  const bars = sparklineBars(counts, sparklineBox);
  const views = artifact.views;
  const summary = `${viewCount(views.last7Days)} in 7 days, ` +
    `${formatCount(views.last30Days)} in ${counts.length} days, ` +
    `${formatCount(views.total)} in all`;
  return (
    <div className="flex items-center gap-3 rounded-lg pr-2 hover:bg-muted/50" data-slot="tree-row">
      <ButtonLink
        className="min-w-0 flex-1 justify-start font-normal"
        href={artifact.url}
        size="sm"
        variant="ghost"
      >
        <IconFileText />
        <span className="truncate">{artifact.name}</span>
      </ButtonLink>
      {artifact.visibility === "public" ? null : (
        <Badge variant="outline">{visibilityLabels[artifact.visibility]}</Badge>
      )}
      <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground md:block">
        {artifact.owner ?? ""}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={(
            <span
              aria-label={`${artifact.name}: ${summary}`}
              className="hidden shrink-0 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:block"
              data-slot="tree-sparkline"
              role="img"
              tabIndex={0}
            />
          )}
        >
          <svg
            aria-hidden="true"
            className="block text-(--chart-views)"
            height={sparklineBox.height}
            viewBox={`0 0 ${sparklineBox.width} ${sparklineBox.height}`}
            width={sparklineBox.width}
          >
            {bars.map((bar, index) => (
              <rect
                className="fill-current"
                height={bar.height}
                key={row.days[index]}
                width={bar.width}
                x={bar.x}
                y={sparklineBox.height - bar.height}
              />
            ))}
          </svg>
        </TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
      <time
        className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block"
        dateTime={artifact.updatedAt}
      >
        {formatUpdated(artifact.updatedAt, row.now)}
      </time>
      {artifact.manage === null
        // A signed-in reader keeps the column, so rows they cannot change
        // stay aligned with the ones they can.
        ? (row.signedIn ? <span aria-hidden="true" className="size-7 shrink-0" /> : null)
        : <ArtifactRowMenu artifact={artifact} handle={artifact.manage} onChanged={row.onChanged} />}
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

/** "3 public artifacts" for an anonymous reader, "3 artifacts" for a member. */
function artifactCount(count: number, signedIn: boolean): string {
  const noun = signedIn ? "artifact" : "public artifact";
  return count === 1 ? `1 ${noun}` : `${formatCount(count)} ${noun}s`;
}

function viewCount(count: number): string {
  return count === 1 ? "1 view" : `${formatCount(count)} views`;
}

/** Which artifacts the tree lists, as its description opens. */
function treeScope(signedIn: boolean, mineOnly: boolean): string {
  if (!signedIn) return "Shared by link";
  return mineOnly ? "Yours" : "Every artifact you can open";
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
