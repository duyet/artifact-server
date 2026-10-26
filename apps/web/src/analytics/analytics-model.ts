import {shiftDay, windowDays} from "../lib/utc-days.js";

/** One day of the sparse series the analytics endpoint returns. */
export interface DailyActivity {
  readonly day: string;
  readonly uploads: number;
  readonly views: number;
}

/** What the heatmap and the day picker can count. */
export type ActivityMetric = "uploads" | "views";

/** One heatmap square. `value` is null outside the window, where no day exists. */
export interface HeatmapCell {
  readonly day: string;
  readonly level: HeatmapLevel;
  readonly value: number | null;
}

/** 0 is "nothing happened"; 1 through 4 are the Less to More legend. */
export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

/** A month name over the first week column that belongs to that month. */
export interface HeatmapMonthLabel {
  readonly label: string;
  readonly week: number;
}

/** Seven cells per week, Sunday first, oldest week first. */
export interface Heatmap {
  readonly months: readonly HeatmapMonthLabel[];
  readonly total: number;
  readonly weeks: readonly (readonly HeatmapCell[])[];
}

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Days a heatmap spans, ending today: one year of columns. */
export const heatmapDays = 365;

/** The least number of week columns a month label needs to stay readable. */
const minimumLabelSpacing = 3;

/**
 * One row per day of the window. The endpoint omits days with nothing in them,
 * so a chart that placed bars by row would squeeze quiet stretches away.
 */
export function densifyDaily(
  sparse: readonly DailyActivity[],
  days: readonly string[],
): readonly DailyActivity[] {
  const byDay = new Map(sparse.map((row) => [row.day, row]));
  return days.map((day) => byDay.get(day) ?? {day, uploads: 0, views: 0});
}

/** The last `count` days up to and including today, with gaps filled in. */
export function recentDaily(
  sparse: readonly DailyActivity[],
  today: string,
  count: number,
): readonly DailyActivity[] {
  return densifyDaily(sparse, windowDays(today, count));
}

/** Sum one metric over rows. */
export function sumMetric(
  rows: readonly DailyActivity[],
  metric: ActivityMetric,
): number {
  return rows.reduce((sum, row) => sum + row[metric], 0);
}

/**
 * Bucket a count into a legend level relative to the busiest day. Any activity
 * is at least level 1, so a single upload is never drawn as an empty square.
 */
export function levelFor(value: number, max: number): HeatmapLevel {
  if (value <= 0 || max <= 0) return 0;
  const level = Math.ceil((value / max) * 4);
  if (level >= 4) return 4;
  if (level <= 1) return 1;
  return level === 2 ? 2 : 3;
}

/**
 * Lay the last year out the way a contribution graph does: a column per week,
 * a row per weekday. The first column starts on the Sunday on or before the
 * window start and the last ends on the Saturday on or after today; squares
 * that fall outside the window carry `value: null`.
 */
export function buildHeatmap(
  sparse: readonly DailyActivity[],
  today: string,
  metric: ActivityMetric,
  days: number = heatmapDays,
): Heatmap {
  const start = shiftDay(today, -(days - 1));
  const gridStart = shiftDay(start, -weekday(start));
  const gridEnd = shiftDay(today, 6 - weekday(today));
  const byDay = new Map(sparse.map((row) => [row.day, row[metric]]));
  const max = Math.max(
    0,
    ...windowDays(today, days).map((day) => byDay.get(day) ?? 0),
  );

  const weeks: HeatmapCell[][] = [];
  let total = 0;
  for (let day = gridStart; day <= gridEnd; day = shiftDay(day, 1)) {
    if (weekday(day) === 0) weeks.push([]);
    const inWindow = day >= start && day <= today;
    const value = inWindow ? byDay.get(day) ?? 0 : null;
    total += value ?? 0;
    weeks.at(-1)?.push({
      day,
      level: value === null ? 0 : levelFor(value, max),
      value,
    });
  }
  return {months: monthLabels(weeks), total, weeks};
}

/**
 * Month names over the first column of each month. A label whose neighbour is
 * closer than three columns would overprint it, so the earlier one is dropped.
 */
function monthLabels(
  weeks: readonly (readonly HeatmapCell[])[],
): readonly HeatmapMonthLabel[] {
  const candidates: HeatmapMonthLabel[] = [];
  let previousMonth: string | null = null;
  weeks.forEach((week, index) => {
    const first = week.find((cell) => cell.value !== null);
    if (first === undefined) return;
    const month = first.day.slice(0, 7);
    if (month === previousMonth) return;
    previousMonth = month;
    candidates.push({label: monthName(first.day), week: index});
  });
  return candidates.filter((candidate, index) => {
    const next = candidates[index + 1];
    return next === undefined || next.week - candidate.week >= minimumLabelSpacing;
  });
}

/** The day's own numbers, or zeros for a day with no row. */
export function dayActivity(
  sparse: readonly DailyActivity[],
  day: string,
): DailyActivity {
  return sparse.find((row) => row.day === day) ?? {day, uploads: 0, views: 0};
}

/** Days that have any upload or view, for marking on the day picker. */
export function activeDays(sparse: readonly DailyActivity[]): readonly string[] {
  return sparse
    .filter((row) => row.uploads > 0 || row.views > 0)
    .map((row) => row.day);
}

/** The local-midnight `Date` the day picker wants for a `YYYY-MM-DD` day. */
export function dayToLocalDate(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** The `YYYY-MM-DD` day a picked local `Date` stands for. */
export function localDateToDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}

/** "Oct 16" for a chart's end labels and a tooltip. */
export function formatDayShort(day: string): string {
  return `${monthName(day)} ${Number(day.slice(8, 10))}`;
}

/** "Oct 16, 2026" for the selected day's heading. */
export function formatDayLong(day: string): string {
  return `${formatDayShort(day)}, ${day.slice(0, 4)}`;
}

/** 0 for Sunday through 6 for Saturday, on the UTC calendar the days live on. */
function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

function monthName(day: string): string {
  return monthNames[Number(day.slice(5, 7)) - 1] ?? "";
}
