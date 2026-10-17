import {useEffect, useState} from "react";
import {IconAlertCircle, IconChartBar} from "@tabler/icons-react";
import {Bar, BarChart, CartesianGrid, XAxis} from "recharts";

import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import {Calendar} from "@/components/ui/calendar";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {Skeleton} from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {cn} from "@/lib/utils";

import {readAnalytics, type AnalyticsReport} from "./analytics-client.js";
import {
  activeDays,
  buildHeatmap,
  dayActivity,
  dayToLocalDate,
  formatDayLong,
  formatDayShort,
  localDateToDay,
  recentDaily,
  sumMetric,
  type ActivityMetric,
  type DailyActivity,
  type HeatmapLevel,
} from "./analytics-model.js";

/** The days the two bar charts cover. */
const chartDays = 30;

const metricLabels = {
  uploads: "Uploads",
  views: "Views",
} satisfies Record<ActivityMetric, string>;

/** Tailwind needs whole class names, so the squares of each metric are spelled out. */
const heatmapLevelClasses = {
  uploads: {
    0: "bg-muted",
    1: "bg-chart-3/25",
    2: "bg-chart-3/50",
    3: "bg-chart-3/75",
    4: "bg-chart-3",
  },
  views: {
    0: "bg-muted",
    1: "bg-chart-2/25",
    2: "bg-chart-2/50",
    3: "bg-chart-2/75",
    4: "bg-chart-2",
  },
} satisfies Record<ActivityMetric, Record<HeatmapLevel, string>>;

/** Weekday labels sit beside their row; Sunday is row 0. */
const weekdayLabels = [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as const;

const chartColors = {
  uploads: "var(--chart-3)",
  views: "var(--chart-2)",
} satisfies Record<ActivityMetric, string>;

type Load =
  | {readonly projectId: string; readonly report: AnalyticsReport; readonly status: "ready"}
  | {readonly message: string; readonly projectId: string; readonly status: "error"};

/**
 * The analytics page for one project. The result is stored with the project it
 * answers, so switching projects shows the skeleton again instead of the
 * previous project's numbers.
 */
export function AnalyticsPage({projectId}: {readonly projectId: string}) {
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadReport = async () => {
      try {
        const report = await readAnalytics(projectId);
        if (!cancelled) setLoad({projectId, report, status: "ready"});
      } catch (cause) {
        if (!cancelled) {
          setLoad({
            message: cause instanceof Error
              ? cause.message
              : "The analytics could not be read.",
            projectId,
            status: "error",
          });
        }
      }
    };
    void loadReport();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = load?.projectId === projectId ? load : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Uploads and page views across this project.
        </p>
      </header>
      {current === null ? <AnalyticsSkeleton /> : null}
      {current?.status === "error"
        ? (
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertTitle>Analytics unavailable</AlertTitle>
            <AlertDescription>{current.message}</AlertDescription>
          </Alert>
        )
        : null}
      {current?.status === "ready" ? <AnalyticsReportView report={current.report} /> : null}
    </div>
  );
}

function AnalyticsReportView({report}: {readonly report: AnalyticsReport}) {
  if (report.totals.artifacts === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><IconChartBar /></EmptyMedia>
          <EmptyTitle>No analytics yet</EmptyTitle>
          <EmptyDescription>
            Publish an artifact and share it. Uploads and views show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const recent = recentDaily(report.daily, report.today, chartDays);
  return (
    <>
      <StatGrid totals={report.totals} />
      <div className="grid gap-4 md:grid-cols-2">
        <ActivityChart metric="uploads" rows={recent} />
        <ActivityChart metric="views" rows={recent} />
      </div>
      <ActivityHeatmap daily={report.daily} today={report.today} />
      <div className="grid items-start gap-4 lg:grid-cols-[auto_1fr]">
        <DayExplorer daily={report.daily} today={report.today} />
        <TopArtifacts artifacts={report.topArtifacts} />
      </div>
    </>
  );
}

function StatGrid({totals}: {readonly totals: AnalyticsReport["totals"]}) {
  const stats: readonly {label: string; value: string}[] = [
    {label: "Total uploads", value: formatCount(totals.uploads)},
    {label: "Uploaded today", value: formatCount(totals.uploadedToday)},
    {label: "Page views", value: formatCount(totals.pageViews)},
    {label: "Docs viewed today", value: formatCount(totals.artifactsViewedToday)},
    {label: "Shared docs", value: formatCount(totals.publicArtifacts)},
    {label: "Avg views per doc", value: formatCount(totals.averageViewsPerArtifact, 1)},
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardHeader>
            <CardDescription>{stat.label}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{stat.value}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function ActivityChart({
  metric,
  rows,
}: {
  readonly metric: ActivityMetric;
  readonly rows: readonly DailyActivity[];
}) {
  const config = {
    [metric]: {color: chartColors[metric], label: metricLabels[metric]},
  } satisfies ChartConfig;
  const data = rows.map((row) => ({...row, date: formatDayLong(row.day)}));
  const first = rows[0]?.day;
  const last = rows.at(-1)?.day;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{metricLabels[metric]}</CardTitle>
        <CardDescription>
          {formatCount(sumMetric(rows, metric))} in the last {rows.length} days
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ChartContainer className="aspect-auto h-40 w-full" config={config}>
          <BarChart accessibilityLayer data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" hide />
            <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
            <Bar
              dataKey={metric}
              fill={`var(--color-${metric})`}
              // The mount animation grows each bar from zero height, so a tab
              // whose animation frames are throttled shows an empty chart.
              isAnimationActive={false}
              radius={2}
            />
          </BarChart>
        </ChartContainer>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{first === undefined ? "" : formatDayShort(first)}</span>
          <span>{last === undefined ? "" : formatDayShort(last)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityHeatmap({
  daily,
  today,
}: {
  readonly daily: readonly DailyActivity[];
  readonly today: string;
}) {
  const [metric, setMetric] = useState<ActivityMetric>("uploads");
  const heatmap = buildHeatmap(daily, today, metric);
  const levelClasses = heatmapLevelClasses[metric];
  const unit = metric === "uploads" ? "uploads" : "views";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          {formatCount(heatmap.total)} {unit} in the last 12 months
        </CardDescription>
        <CardAction>
          <ToggleGroup
            aria-label="Activity metric"
            onValueChange={(value) => {
              const next = value[0];
              if (next === "uploads" || next === "views") setMetric(next);
            }}
            size="sm"
            value={[metric]}
            variant="outline"
          >
            <ToggleGroupItem value="uploads">Uploads</ToggleGroupItem>
            <ToggleGroupItem value="views">Views</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          aria-label="Activity heatmap"
          className="overflow-x-auto pb-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          // A scroll container has to be reachable by keyboard.
          role="region"
          tabIndex={0}
        >
          <div
            className="grid min-w-[46rem] gap-0.5"
            style={{gridTemplateColumns: `1.75rem repeat(${heatmap.weeks.length}, minmax(0, 1fr))`}}
          >
            {heatmap.months.map((month) => (
              <span
                aria-hidden="true"
                className="overflow-visible whitespace-nowrap pb-1 text-[10px] leading-3 text-muted-foreground"
                key={month.week}
                style={{gridColumn: month.week + 2, gridRow: 1}}
              >
                {month.label}
              </span>
            ))}
            {weekdayLabels.map(([row, label]) => (
              <span
                aria-hidden="true"
                className="flex items-center text-[10px] leading-3 text-muted-foreground"
                key={label}
                style={{gridColumn: 1, gridRow: row + 2}}
              >
                {label}
              </span>
            ))}
            <div
              aria-label={`${formatCount(heatmap.total)} ${unit} per day over the last 12 months`}
              className="grid grid-cols-subgrid grid-rows-subgrid"
              role="img"
              style={{gridColumn: "2 / -1", gridRow: "2 / span 7"}}
            >
              {heatmap.weeks.map((week, weekIndex) => week.map((cell, dayIndex) => cell.value === null
                ? null
                : (
                  <span
                    className={cn("aspect-square rounded-[3px]", levelClasses[cell.level])}
                    key={cell.day}
                    style={{gridColumn: weekIndex + 1, gridRow: dayIndex + 1}}
                    title={`${formatDayLong(cell.day)}: ${cell.value} ${unit}`}
                  />
                )))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          <span>Less</span>
          {([0, 1, 2, 3, 4] as const).map((level) => (
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-[3px]", levelClasses[level])}
              key={level}
            />
          ))}
          <span>More</span>
        </div>
      </CardContent>
    </Card>
  );
}

function DayExplorer({
  daily,
  today,
}: {
  readonly daily: readonly DailyActivity[];
  readonly today: string;
}) {
  const [selectedDay, setSelectedDay] = useState(today);
  const activity = dayActivity(daily, selectedDay);
  const todayDate = dayToLocalDate(today);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Day by day</CardTitle>
        <CardDescription>Pick a day to see what happened on it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <Calendar
          className="p-0"
          defaultMonth={todayDate}
          disabled={{after: todayDate}}
          mode="single"
          modifiers={{active: activeDays(daily).map(dayToLocalDate)}}
          modifiersClassNames={{
            active:
              "[&>button]:after:absolute [&>button]:after:bottom-1 [&>button]:after:left-1/2 [&>button]:after:size-1 [&>button]:after:-translate-x-1/2 [&>button]:after:rounded-full [&>button]:after:bg-chart-2 [&>button[data-selected-single=true]]:after:bg-primary-foreground",
          }}
          onSelect={(date) => {
            setSelectedDay(localDateToDay(date));
          }}
          required
          selected={dayToLocalDate(selectedDay)}
        />
        <div aria-live="polite" className="flex min-w-40 flex-col gap-3">
          <p className="text-sm font-medium">{formatDayLong(selectedDay)}</p>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-muted-foreground">Uploads</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {formatCount(activity.uploads)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Views</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {formatCount(activity.views)}
              </dd>
            </div>
          </dl>
          {activity.uploads === 0 && activity.views === 0
            ? <p className="text-xs text-muted-foreground">Nothing happened on this day.</p>
            : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TopArtifacts({artifacts}: {readonly artifacts: AnalyticsReport["topArtifacts"]}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top artifacts</CardTitle>
        <CardDescription>Most viewed over the last 30 days.</CardDescription>
      </CardHeader>
      <CardContent>
        {artifacts.length === 0
          ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No views yet</EmptyTitle>
                <EmptyDescription>
                  Artifacts appear here once someone opens them.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Artifact</TableHead>
                  <TableHead className="text-right">Views (30d)</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {artifacts.map((artifact) => (
                  <TableRow key={artifact.artifactId}>
                    <TableCell className="w-full max-w-0 truncate font-medium">
                      {artifact.name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(artifact.views30d)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatCount(artifact.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  );
}

function AnalyticsSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({length: 6}, (_, index) => (
          <Skeleton className="h-20 rounded-xl" key={index} />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <Skeleton className="h-52 rounded-xl" />
    </div>
  );
}

function formatCount(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(undefined, {maximumFractionDigits}).format(value);
}
