import {cn} from "@/lib/utils";

const box = {gap: 1, height: 20, width: 90} as const;

/**
 * One bar per value, scaled to the tallest, in the current text color. A
 * series of zeros draws zero-height bars, so the box keeps its size.
 */
export function Sparkline({
  className,
  label,
  values,
}: {
  readonly className?: string;
  /** What the bars say, read by assistive technology instead of the bars. */
  readonly label: string;
  readonly values: readonly number[];
}) {
  const width = values.length === 0
    ? 0
    : Math.max(1, (box.width - box.gap * (values.length - 1)) / values.length);
  // A floor of 1 keeps an all-zero series from dividing by zero.
  const tallest = Math.max(1, ...values);
  return (
    <svg
      aria-label={label}
      className={cn("block shrink-0 text-chart-1", className)}
      height={box.height}
      role="img"
      viewBox={`0 0 ${box.width} ${box.height}`}
      width={box.width}
    >
      {values.map((value, index) => {
        const height = Math.round((Math.max(0, value) / tallest) * box.height);
        return (
          <rect
            className="fill-current"
            height={height}
            // Bars never reorder, so a position is a stable key.
            key={index}
            width={width}
            x={index * (width + box.gap)}
            y={box.height - height}
          />
        );
      })}
    </svg>
  );
}
