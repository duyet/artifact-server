import {describe, expect, test} from "vitest";

import {
  activeDays,
  buildHeatmap,
  dayActivity,
  dayToLocalDate,
  densifyDaily,
  formatDayLong,
  formatDayShort,
  levelFor,
  localDateToDay,
  recentDaily,
  shiftDay,
  sumMetric,
  windowDays,
  type DailyActivity,
} from "../../apps/web/src/analytics/analytics-model.js";

// 2026-10-18 is a Sunday, which makes the week columns easy to count by hand.
const today = "2026-10-18";

const sparse: readonly DailyActivity[] = [
  {day: "2026-10-10", uploads: 0, views: 2},
  {day: "2026-10-12", uploads: 3, views: 8},
  {day: "2026-10-18", uploads: 1, views: 4},
];

describe("analytics day windows", () => {
  test("shiftDay crosses month and year boundaries on the UTC calendar", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
  });

  test("windowDays ends today, oldest first, with exactly `count` days", () => {
    expect(windowDays("2026-10-18", 4)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
  });

  test("densifyDaily fills every quiet day with zeros so bars keep their place", () => {
    expect(densifyDaily(sparse, windowDays(today, 3))).toEqual([
      {day: "2026-10-16", uploads: 0, views: 0},
      {day: "2026-10-17", uploads: 0, views: 0},
      {day: "2026-10-18", uploads: 1, views: 4},
    ]);
  });

  test("recentDaily is thirty rows for the thirty-day charts and drops older activity", () => {
    const rows = recentDaily(
      [{day: "2026-09-01", uploads: 9, views: 9}, ...sparse],
      today,
      30,
    );
    expect(rows).toHaveLength(30);
    expect(rows[0]?.day).toBe("2026-09-19");
    expect(rows.at(-1)).toEqual({day: "2026-10-18", uploads: 1, views: 4});
    expect(sumMetric(rows, "views")).toBe(14);
    expect(sumMetric(rows, "uploads")).toBe(4);
  });
});

describe("heatmap levels", () => {
  test("nothing is level 0 and any activity is at least level 1", () => {
    expect(levelFor(0, 8)).toBe(0);
    expect(levelFor(1, 100)).toBe(1);
    expect(levelFor(5, 0)).toBe(0);
  });

  test("the busiest day is level 4 and the quarters step up between", () => {
    expect(levelFor(2, 8)).toBe(1);
    expect(levelFor(3, 8)).toBe(2);
    expect(levelFor(5, 8)).toBe(3);
    expect(levelFor(8, 8)).toBe(4);
  });
});

describe("heatmap grid", () => {
  test("weeks start on Sunday and squares outside the window carry no value", () => {
    const heatmap = buildHeatmap(sparse, today, "views", 10);

    expect(heatmap.weeks.map((week) => week.length)).toEqual([7, 7, 7]);
    expect(heatmap.weeks.map((week) => week[0]?.day)).toEqual([
      "2026-10-04",
      "2026-10-11",
      "2026-10-18",
    ]);
    // The window is Oct 9 through Oct 18, so Oct 4 to 8 and Oct 19 to 24 are padding.
    expect(heatmap.weeks[0]?.map((cell) => cell.value)).toEqual([
      null,
      null,
      null,
      null,
      null,
      0,
      2,
    ]);
    expect(heatmap.weeks[2]?.map((cell) => cell.value)).toEqual([
      4,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("levels are relative to the busiest day of the chosen metric", () => {
    const views = buildHeatmap(sparse, today, "views", 10);
    expect(views.total).toBe(14);
    expect(views.weeks[0]?.[6]).toEqual({day: "2026-10-10", level: 1, value: 2});
    expect(views.weeks[1]?.[1]).toEqual({day: "2026-10-12", level: 4, value: 8});
    expect(views.weeks[2]?.[0]).toEqual({day: "2026-10-18", level: 2, value: 4});

    const uploads = buildHeatmap(sparse, today, "uploads", 10);
    expect(uploads.total).toBe(4);
    expect(uploads.weeks[1]?.[1]).toEqual({day: "2026-10-12", level: 4, value: 3});
    expect(uploads.weeks[2]?.[0]).toEqual({day: "2026-10-18", level: 2, value: 1});
  });

  test("a year has 53 week columns and a month label only where it fits", () => {
    const heatmap = buildHeatmap([], today, "views");

    expect(heatmap.weeks).toHaveLength(53);
    expect(heatmap.weeks[0]?.[0]?.day).toBe("2025-10-19");
    expect(heatmap.weeks[52]?.[0]?.day).toBe("2026-10-18");
    // Oct 2025 starts partway through week 0 and Nov begins two columns later,
    // so the first label would overprint the second and is dropped.
    expect(heatmap.months.map((month) => month.label)).toEqual([
      "Nov",
      "Dec",
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
    ]);
    expect(heatmap.months[0]?.week).toBe(2);
    expect(heatmap.months.at(-1)?.week).toBe(50);
  });
});

describe("day picker bridging", () => {
  test("dayActivity reads a day's numbers and zeroes a day with no row", () => {
    expect(dayActivity(sparse, "2026-10-12")).toEqual({
      day: "2026-10-12",
      uploads: 3,
      views: 8,
    });
    expect(dayActivity(sparse, "2026-10-13")).toEqual({
      day: "2026-10-13",
      uploads: 0,
      views: 0,
    });
  });

  test("activeDays lists only days with an upload or a view", () => {
    expect(activeDays([
      ...sparse,
      {day: "2026-10-14", uploads: 0, views: 0},
    ])).toEqual(["2026-10-10", "2026-10-12", "2026-10-18"]);
  });

  test("a day survives the round trip through a local Date in any timezone", () => {
    expect(localDateToDay(dayToLocalDate("2026-01-05"))).toBe("2026-01-05");
    expect(localDateToDay(dayToLocalDate("2026-12-31"))).toBe("2026-12-31");
    expect(dayToLocalDate("2026-10-18").getDate()).toBe(18);
  });

  test("day labels read as short and long dates", () => {
    expect(formatDayShort("2026-10-06")).toBe("Oct 6");
    expect(formatDayLong("2026-10-16")).toBe("Oct 16, 2026");
  });
});
