import type { CSSProperties } from "react";

/** Inline style that also carries CSS custom properties such as `--sidebar-width`. */
export type CssVariableStyle = CSSProperties &
  Record<`--${string}`, number | string | undefined>;
