import {
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconInfoCircle,
} from "@tabler/icons-react";
import {Bar, BarChart, CartesianGrid, XAxis} from "recharts";

import {Alert, AlertDescription} from "@/components/ui/alert";
import {Badge} from "@/components/ui/badge";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Card,
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

import {
  buildPublicArtifactTree,
  densifyDailySeries,
  sparklineBars,
  sparklineBox,
  sumDailySeries,
  windowDays,
  type PublicArtifactTreeEntry,
  type PublicArtifactTreeFolder,
} from "./home-tree.js";
import type {PublicCatalog} from "./home-client.js";

const viewsChartConfig = {
  views: {color: "var(--chart-2)", label: "Views"},
} satisfies ChartConfig;

/**
 * The home page. Every colour is a semantic token, so the application's theme
 * reaches this page without an edit here.
 */
export function HomePage({catalog}: {readonly catalog: PublicCatalog}) {
  const now = Date.now();
  const days = windowDays(todayUtc(), catalog.windowDays);
  const tree = buildPublicArtifactTree(catalog.artifacts);
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
        <nav aria-label="Primary">
          <ButtonLink href="/review" variant="outline">Workbench</ButtonLink>
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
        values={densifyDailySeries(sumDailySeries(catalog.artifacts), days)}
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
              <CardDescription>Shared by link, newest first.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {tree.folders.map((folder) => (
                <FolderNode key={folder.path} days={days} folder={folder} now={now} />
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

/** One bar per day, summed across every public artifact. */
function DailyChart({
  days,
  values,
}: {
  readonly days: readonly string[];
  readonly values: readonly number[];
}) {
  const data = days.map((day, index) => ({day, views: values[index] ?? 0}));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Views per day</CardTitle>
        <CardDescription>Across every public artifact.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ChartContainer className="aspect-auto h-32 w-full" config={viewsChartConfig}>
          <BarChart accessibilityLayer data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="day" hide />
            <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
            <Bar dataKey="views" fill="var(--color-views)" radius={2} />
          </BarChart>
        </ChartContainer>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{days[0] ?? ""}</span>
          <span>{days[days.length - 1] ?? ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A folder row in the file-tree pattern: a Collapsible whose trigger is a
 * Button. The row is a heading so a reader can jump between folders.
 */
function TreeFolder({
  children,
  id,
  name,
  prefix = "",
}: {
  readonly children: React.ReactNode;
  readonly id: string;
  readonly name: string;
  /** The path above `name`, spoken but not drawn: the indent already shows it. */
  readonly prefix?: string;
}) {
  return (
    <Collapsible defaultOpen>
      <h2 id={id}>
        <CollapsibleTrigger
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
          <span className="sr-only">{prefix}</span>
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
  days,
  folder,
  now,
}: {
  readonly days: readonly string[];
  readonly folder: PublicArtifactTreeFolder;
  readonly now: number;
}) {
  return (
    <TreeFolder
      id={`folder-${folder.path}`}
      name={folder.label}
      prefix={folder.path.slice(0, folder.path.length - folder.label.length)}
    >
      {folder.artifacts.map((artifact) => (
        <ArtifactNode key={artifact.url} artifact={artifact} days={days} now={now} />
      ))}
      {folder.folders.map((child) => (
        <FolderNode key={child.path} days={days} folder={child} now={now} />
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
          className="block text-chart-3"
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
