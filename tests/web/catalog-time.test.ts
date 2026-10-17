import {describe, expect, test} from "vitest";

import {dayLabel, groupByDay, relativeTime} from "../../apps/web/src/review/catalog/catalog-time.js";

// Local-time constructors keep these assertions independent of the runner's zone.
const now = new Date(2026, 9, 18, 9, 30);

describe("catalog day grouping", () => {
  test("names today and yesterday by word and older days by date", () => {
    expect(dayLabel(new Date(2026, 9, 18, 0, 5), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 17, 23, 59), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 16, 12), now))
      .toBe(new Date(2026, 9, 16).toLocaleDateString(undefined, {day: "numeric", month: "short"}));
    expect(dayLabel(new Date(2025, 9, 16, 12), now)).toContain("2025");
  });

  test("puts artifacts edited on the same local day under one heading in input order", () => {
    const artifacts = [
      {id: "a", updatedAt: new Date(2026, 9, 18, 8).toISOString()},
      {id: "b", updatedAt: new Date(2026, 9, 18, 1).toISOString()},
      {id: "c", updatedAt: new Date(2026, 9, 17, 22).toISOString()},
      {id: "d", updatedAt: new Date(2026, 9, 12, 10).toISOString()},
    ];

    const groups = groupByDay(artifacts, (artifact) => artifact.updatedAt, now);

    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [dayLabel(new Date(2026, 9, 12), now), ["d"]],
    ]);
  });

  test("says how long ago an edit happened, then falls back to the date after a week", () => {
    const ago = (milliseconds: number): string => new Date(now.getTime() - milliseconds).toISOString();
    expect(relativeTime(ago(20_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeTime(ago(11 * 3_600_000), now)).toBe("11h ago");
    expect(relativeTime(ago(3 * 86_400_000), now)).toBe("3d ago");
    expect(relativeTime(ago(9 * 86_400_000), now)).toBe(dayLabel(new Date(now.getTime() - 9 * 86_400_000), now));
  });
});
