import {describe, expect, test} from "vitest";

import {
  buildPublicArtifactTree,
  busiestDay,
  dayTone,
  densifyDailySeries,
  entriesOnDay,
  sparklineBars,
  sparklineBox,
  sumDailySeries,
  windowDays,
  type PublicArtifactTreeEntry,
} from "../../apps/web/src/home/home-tree.js";

function entry(
  name: string,
  path: string | null,
  updatedAt: string,
  overrides: Partial<PublicArtifactTreeEntry> = {},
): PublicArtifactTreeEntry {
  return {
    name,
    path,
    series: [],
    updatedAt,
    updates: [],
    url: `https://artifacts.example.internal/${path ?? `loose-${name}`}/`,
    views: {last7Days: 0, last30Days: 0, total: 0},
    ...overrides,
  };
}

describe("public artifact tree", () => {
  test("paths nest into folders labelled with their last segment, newest first", () => {
    const tree = buildPublicArtifactTree([
      entry("Agent console", "2026/10/agent-console", "2026-10-01T00:00:00.000Z"),
      entry("Cost report", "2026/11/cost-report", "2026-11-01T00:00:00.000Z"),
      entry("Weekly", "2026/10/weekly", "2026-10-20T00:00:00.000Z"),
      entry("Plan", "2027/01/plan", "2027-01-01T00:00:00.000Z"),
      entry("Loose report", null, "2026-12-01T00:00:00.000Z"),
    ]);

    // `2027` is newer than `2026`, so it leads.
    expect(tree.folders.map((folder) => folder.label)).toEqual(["2027", "2026"]);
    const [y2027, y2026] = tree.folders;
    expect(y2027?.path).toBe("2027");
    expect(y2027?.folders.map((folder) => folder.label)).toEqual(["01"]);
    expect(y2027?.folders[0]?.path).toBe("2027/01");
    expect(y2027?.folders[0]?.artifacts.map((a) => a.name)).toEqual(["Plan"]);
    // `11` is newer than `10`, so it leads inside `2026`.
    expect(y2026?.folders.map((folder) => folder.label)).toEqual(["11", "10"]);
    const [eleven, ten] = y2026?.folders ?? [];
    expect(eleven?.path).toBe("2026/11");
    expect(eleven?.artifacts.map((a) => a.name)).toEqual(["Cost report"]);
    expect(ten?.path).toBe("2026/10");
    expect(ten?.artifacts.map((a) => a.name)).toEqual([
      "Weekly",
      "Agent console",
    ]);
    expect(tree.ungrouped.map((a) => a.name)).toEqual(["Loose report"]);
  });

  test("a folder holds both the artifacts that sit in it and the folders below", () => {
    const tree = buildPublicArtifactTree([
      entry("Plan", "2026/10/plan/sub", "2026-10-30T00:00:00.000Z"),
      entry("Weekly", "2026/10/weekly", "2026-10-20T00:00:00.000Z"),
    ]);
    const ten = tree.folders[0];
    expect(ten?.label).toBe("2026");
    expect(ten?.folders.map((folder) => folder.label)).toEqual(["10"]);
    const october = ten?.folders[0];
    expect(october?.artifacts.map((a) => a.name)).toEqual(["Weekly"]);
    expect(october?.folders.map((folder) => folder.label)).toEqual(["plan"]);
    expect(october?.folders[0]?.artifacts.map((a) => a.name)).toEqual(["Plan"]);
  });

  test("a one-segment path becomes a group, because nothing can live under it", () => {
    const tree = buildPublicArtifactTree([
      entry("Index", "2026", "2026-10-01T00:00:00.000Z"),
    ]);
    expect(tree.folders.map((folder) => folder.label)).toEqual(["2026"]);
    expect(tree.folders[0]?.artifacts.map((a) => a.name)).toEqual(["Index"]);
    expect(tree.ungrouped).toEqual([]);
  });

  test("a pathless artifact collects in its own list and never becomes a folder", () => {
    const tree = buildPublicArtifactTree([
      entry("Loose report", null, "2026-10-02T00:00:00.000Z"),
      entry("Loose memo", null, "2026-10-03T00:00:00.000Z"),
    ]);
    expect(tree.folders).toEqual([]);
    expect(tree.ungrouped.map((a) => a.name)).toEqual([
      "Loose memo",
      "Loose report",
    ]);
  });

  test("artifacts published in the same instant keep a total order", () => {
    const sameInstant = "2026-10-17T09:00:00.000Z";
    const tree = buildPublicArtifactTree([
      entry("Second", "2026/10/second", sameInstant),
      entry("First", "2026/10/first", sameInstant),
    ]);
    // `updatedAt` cannot separate them, so the unique URL decides, and it
    // decides the same way on every reader.
    const october = tree.folders[0]?.folders[0];
    expect(october?.artifacts.map((a) => a.name)).toEqual(["First", "Second"]);
  });

  test("an empty catalog produces an empty tree rather than throwing", () => {
    expect(buildPublicArtifactTree([])).toEqual({folders: [], ungrouped: []});
  });
});

describe("daily view series", () => {
  test("the window walks backwards from its last day and includes both ends", () => {
    expect(windowDays("2026-10-17", 3)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
    ]);
    expect(windowDays("2026-01-01", 1)).toEqual(["2026-01-01"]);
    // A window crossing a month boundary and a leap day is still consecutive.
    expect(windowDays("2028-03-01", 3)).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  test("a sparse series fills every day of the window with a zero", () => {
    const days = windowDays("2026-10-17", 5);
    expect(densifyDailySeries(
      [{count: 3, day: "2026-10-16"}, {count: 1, day: "2026-10-17"}],
      days,
    )).toEqual([0, 0, 0, 3, 1]);
    expect(densifyDailySeries([], days)).toEqual([0, 0, 0, 0, 0]);
  });

  test("the page chart sums the rows of the chosen measure, so it cannot disagree with them", () => {
    const entries = [
      entry("A", "2026/10/a", "2026-10-17T00:00:00.000Z", {
        series: [{count: 2, day: "2026-10-17"}, {count: 1, day: "2026-10-15"}],
        updates: [{count: 3, day: "2026-10-16"}],
      }),
      entry("B", "2026/10/b", "2026-10-17T00:00:00.000Z", {
        series: [{count: 5, day: "2026-10-17"}],
        updates: [{count: 1, day: "2026-10-16"}, {count: 1, day: "2026-10-17"}],
      }),
    ];
    expect(sumDailySeries(entries, "views")).toEqual([
      {count: 1, day: "2026-10-15"},
      {count: 7, day: "2026-10-17"},
    ]);
    expect(sumDailySeries(entries, "updates")).toEqual([
      {count: 4, day: "2026-10-16"},
      {count: 1, day: "2026-10-17"},
    ]);
  });
});

function names(list: readonly PublicArtifactTreeEntry[]): readonly string[] {
  return list.map((item) => item.name);
}

describe("day filter", () => {
  const entries = [
    entry("Agent console", "2026/10/agent-console", "2026-10-16T00:00:00.000Z", {
      series: [{count: 4, day: "2026-10-17"}],
      updates: [{count: 1, day: "2026-10-16"}],
    }),
    entry("Cost report", "2026/10/cost-report", "2026-10-17T00:00:00.000Z", {
      updates: [{count: 2, day: "2026-10-17"}],
    }),
    entry("Capacity plan", "2026/11/capacity-plan", "2026-10-17T00:00:00.000Z", {
      series: [{count: 1, day: "2026-10-16"}],
      updates: [{count: 1, day: "2026-10-17"}],
    }),
    entry("Loose report", null, "2026-10-17T00:00:00.000Z", {
      series: [{count: 1, day: "2026-10-17"}],
    }),
  ];
  test("views and updates on one day pick different artifacts", () => {
    expect(names(entriesOnDay(entries, "views", "2026-10-17")))
      .toEqual(["Agent console", "Loose report"]);
    expect(names(entriesOnDay(entries, "updates", "2026-10-17")))
      .toEqual(["Cost report", "Capacity plan"]);
    expect(names(entriesOnDay(entries, "updates", "2026-10-16")))
      .toEqual(["Agent console"]);
    expect(entriesOnDay(entries, "views", "2026-10-01")).toEqual([]);
  });

  test("the filtered tree keeps the folder path to each match and drops empty folders", () => {
    const tree = buildPublicArtifactTree(
      entriesOnDay(entries, "views", "2026-10-17"),
    );
    expect(tree.folders.map((folder) => folder.path)).toEqual(["2026"]);
    expect(tree.folders[0]?.folders.map((folder) => folder.path))
      .toEqual(["2026/10"]);
    expect(names(tree.folders[0]?.folders[0]?.artifacts ?? []))
      .toEqual(["Agent console"]);
    expect(names(tree.ungrouped)).toEqual(["Loose report"]);

    const updated = buildPublicArtifactTree(
      entriesOnDay(entries, "updates", "2026-10-17"),
    );
    // Both folders' newest artifact shares one instant, so the label decides.
    expect(updated.folders[0]?.folders.map((folder) => folder.path))
      .toEqual(["2026/10", "2026/11"]);
    expect(updated.ungrouped).toEqual([]);
  });
});

describe("daily chart tones and summary", () => {
  test("FRK-025-F: no selection keeps every bar full, a selection tints the rest, and an empty window names no busiest day", () => {
    const days = ["2026-10-15", "2026-10-16", "2026-10-17"];
    // With nothing selected the chart wears its accent, and only the day
    // under the pointer steps down.
    expect(days.map((day) => dayTone(day, null, null))).toEqual(["full", "full", "full"]);
    expect(days.map((day) => dayTone(day, null, "2026-10-16"))).toEqual(["full", "hover", "full"]);
    // A selection keeps its accent even under the pointer, and every other
    // day recedes to the tint.
    expect(days.map((day) => dayTone(day, "2026-10-17", null))).toEqual(["muted", "muted", "full"]);
    expect(days.map((day) => dayTone(day, "2026-10-17", "2026-10-15"))).toEqual(["hover", "muted", "full"]);
    expect(dayTone("2026-10-17", "2026-10-17", "2026-10-17")).toBe("full");

    expect(busiestDay([0, 0, 0], days)).toBeNull();
    expect(busiestDay([], [])).toBeNull();
    // A tie goes to the latest day.
    expect(busiestDay([3, 1, 3], days)).toEqual({count: 3, day: "2026-10-17"});
    expect(busiestDay([5, 1, 3], days)).toEqual({count: 5, day: "2026-10-15"});
  });
});

describe("sparkline geometry", () => {
  test("bar heights scale to the tallest value and share the box width", () => {
    const bars = sparklineBars([0, 1, 2, 4], sparklineBox);
    expect(bars.map((bar) => bar.height)).toEqual([0, 6, 12, 24]);
    const total = bars.reduce((sum, bar) => sum + bar.width, 0) +
      sparklineBox.gap * (bars.length - 1);
    expect(total).toBeCloseTo(sparklineBox.width, 6);
    expect(bars[0]?.x).toBe(0);
  });

  test("a series with no views draws zero-height bars instead of an empty box", () => {
    const bars = sparklineBars([0, 0, 0], sparklineBox);
    expect(bars).toHaveLength(3);
    expect(bars.every((bar) => bar.height === 0)).toBe(true);
    expect(bars.every((bar) => bar.width > 0)).toBe(true);
  });

  test("a single value fills the box and an empty series draws nothing", () => {
    expect(sparklineBars([9], sparklineBox)).toEqual([
      {height: 24, width: sparklineBox.width, x: 0},
    ]);
    expect(sparklineBars([], sparklineBox)).toEqual([]);
  });
});