import type {CssVariableStyle} from "./css-variables.js";

/**
 * The `--color-<key>` properties a chart's series read. They go on the chart
 * container's style property: the application CSP (`style-src 'self'`) blocks
 * an inline <style> element, which left every series without a colour.
 */
export function chartColorStyle<Entry extends {readonly color?: string}>(
  config: Readonly<Record<string, Entry>>,
): CssVariableStyle {
  const style: CssVariableStyle = {};
  for (const [key, entry] of Object.entries(config)) {
    if (entry.color !== undefined) style[`--color-${key}`] = entry.color;
  }
  return style;
}
