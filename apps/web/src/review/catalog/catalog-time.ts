/** Items that fall on one local calendar day, newest day first. */
export interface DayGroup<Item> {
  readonly items: readonly Item[];
  /** The local calendar day, as YYYY-MM-DD. */
  readonly key: string;
  readonly label: string;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** "Today", "Yesterday", "Oct 16", or "Oct 16, 2025" for an earlier year. */
export function dayLabel(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString(undefined, {day: "numeric", month: "short"})
    : date.toLocaleDateString(undefined, {day: "numeric", month: "short", year: "numeric"});
}

/**
 * Group items by the local day of their timestamp, keeping the input order
 * inside each day. The input is expected newest first, as the catalog sorts it.
 */
export function groupByDay<Item>(
  items: readonly Item[],
  timestampOf: (item: Item) => string,
  now: Date,
): readonly DayGroup<Item>[] {
  const groups = new Map<string, {items: Item[]; label: string}>();
  for (const item of items) {
    const date = new Date(timestampOf(item));
    const key = localDayKey(date);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, {items: [item], label: dayLabel(date, now)});
    else group.items.push(item);
  }
  return [...groups.entries()].map(([key, group]) => ({items: group.items, key, label: group.label}));
}

/** "just now", "5m ago", "11h ago", "3d ago", then the calendar date. */
export function relativeTime(timestamp: string, now: Date): string {
  const date = new Date(timestamp);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < minute) return "just now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;
  return dayLabel(date, now);
}
