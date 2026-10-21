import {describe, expect, test} from "vitest";

import {chartColorStyle} from "../../apps/web/src/lib/chart-color-style.js";

describe("chart colours", () => {
  // The application CSP is `style-src 'self'`, which blocks an inline <style>
  // element. A series colour must reach `var(--color-<key>)` through the
  // container's style property, which the CSP allows.
  test("carry each configured series colour as a --color-<key> property", () => {
    expect(chartColorStyle({
      uploads: {color: "var(--chart-3)", label: "Uploads"},
      views: {color: "var(--chart-1)", label: "Views"},
    })).toEqual({
      "--color-uploads": "var(--chart-3)",
      "--color-views": "var(--chart-1)",
    });
  });

  test("leave a series without a colour unset", () => {
    expect(chartColorStyle<{color?: string; label: string}>({
      views: {label: "Views"},
    })).toEqual({});
  });
});
