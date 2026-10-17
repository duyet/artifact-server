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

/**
 * The home page. Structure comes from 1px hairlines and tabular numbers, the
 * way https://html.duyet.net/ does it, and every colour is a semantic token so
 * the application's theme reaches this page without an edit here.
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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10">
      <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Artifact Server
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {artifactCount(catalog.artifacts.length)}
          </p>
        </div>
        <nav className="flex gap-4 text-sm">
          <a className="text-muted-foreground hover:text-foreground" href="/review">
            Workbench
          </a>
        </nav>
      </header>

      <section aria-labelledby="home-totals" className="grid grid-cols-3 border">
        <h2 className="sr-only" id="home-totals">View totals</h2>
        <TotalCell label="Last 7 days" value={totals.last7Days} />
        <TotalCell label="Last 30 days" value={totals.last30Days} />
        <TotalCell label="All time" value={totals.total} />
      </section>

      <section aria-labelledby="home-chart" className="flex flex-col gap-3 border p-5">
        <h2
          className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
          id="home-chart"
        >
          Views per day
        </h2>
        <DailyChart
          days={days}
          values={densifyDailySeries(sumDailySeries(catalog.artifacts), days)}
        />
      </section>

      {catalog.truncated ? (
        <p className="border border-dashed p-4 text-sm text-muted-foreground">
          This installation holds more public artifacts than this page shows.
        </p>
      ) : null}

      {catalog.artifacts.length === 0
        ? <EmptyCatalog />
        : (
          <div className="flex flex-col gap-8">
            {tree.folders.map((folder) => (
              <Folder key={folder.path} days={days} folder={folder} now={now} />
            ))}
            {tree.ungrouped.length === 0 ? null : (
              <section aria-labelledby="home-ungrouped" className="flex flex-col gap-3">
                <h2
                  className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
                  id="home-ungrouped"
                >
                  Without a path
                </h2>
                <ul className="flex flex-col border">
                  {tree.ungrouped.map((artifact) => (
                    <ArtifactRow
                      key={artifact.url}
                      artifact={artifact}
                      days={days}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
    </main>
  );
}

function EmptyCatalog() {
  return (
    <section className="border p-6">
      <h2 className="font-heading text-lg font-semibold">Nothing published yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        No artifact on this server is shared by link. Publish one with a public link
        and it appears here.
      </p>
    </section>
  );
}

function TotalCell({label, value}: {readonly label: string; readonly value: number}) {
  return (
    <div className="border-r px-5 py-4 last:border-r-0">
      <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-1 font-heading text-3xl font-semibold tabular-nums">
        {formatCount(value)}
      </p>
    </div>
  );
}

const pageChartBox = {gap: 2, height: 72, width: 640} as const;

/**
 * One bar per day, summed across every public artifact. The bars are the only
 * markup: no chart library, no layout measurement, and nothing a reader has to
 * download to see a shape made of thirty rectangles.
 */
function DailyChart({
  days,
  values,
}: {
  readonly days: readonly string[];
  readonly values: readonly number[];
}) {
  const bars = sparklineBars(values, pageChartBox);
  return (
    <figure className="flex flex-col gap-2">
      <svg
        aria-hidden="true"
        className="h-[72px] w-full text-chart-2"
        preserveAspectRatio="none"
        role="presentation"
        viewBox={`0 0 ${pageChartBox.width} ${pageChartBox.height}`}
      >
        {bars.map((bar, index) => (
          <rect
            className="fill-current"
            height={bar.height}
            key={days[index]}
            width={bar.width}
            x={bar.x}
            y={pageChartBox.height - bar.height}
          />
        ))}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{days[0] ?? ""}</span>
        <span>{days[days.length - 1] ?? ""}</span>
      </figcaption>
    </figure>
  );
}

function Folder({
  days,
  folder,
  now,
}: {
  readonly days: readonly string[];
  readonly folder: PublicArtifactTreeFolder;
  readonly now: number;
}) {
  return (
    <section aria-labelledby={`folder-${folder.path}`} className="flex flex-col gap-3">
      <h2
        className="font-mono text-xs font-semibold tracking-widest text-muted-foreground uppercase"
        id={`folder-${folder.path}`}
      >
        {folder.path}
      </h2>
      <ul className="flex flex-col border">
        {folder.artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.url}
            artifact={artifact}
            days={days}
            now={now}
          />
        ))}
        {folder.folders.map((child) => (
          <li className="border-b last:border-b-0" key={child.path}>
            <div className="border-l pl-4">
              <Folder days={days} folder={child} now={now} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArtifactRow({
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
    <li className="flex items-center gap-4 border-b px-5 py-3 last:border-b-0 hover:bg-accent/40">
      <a
        className="min-w-0 flex-1 truncate font-medium hover:underline"
        href={artifact.url}
      >
        {artifact.name}
      </a>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {artifact.views.last7Days} / 7d
      </span>
      <span className="shrink-0">
        <span className="sr-only">
          {`${artifact.views.last30Days} views over ${counts.length} days, ` +
            `${artifact.views.total} in all`}
        </span>
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
              key={counts[index]}
              width={bar.width}
              x={bar.x}
              y={sparklineBox.height - bar.height}
            />
          ))}
        </svg>
      </span>
      <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
        {formatCount(artifact.views.total)}
      </span>
      <time
        className="hidden w-40 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block"
        dateTime={artifact.updatedAt}
      >
        {formatUpdated(artifact.updatedAt, now)}
      </time>
    </li>
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