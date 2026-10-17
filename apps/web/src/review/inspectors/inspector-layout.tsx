import type {ReactNode} from "react";

export type InspectorTab = "activity" | "comments" | "compare" | "details" | "files" | "versions";

export function InspectorSection({
  action,
  children,
  count,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly count: number;
  readonly title: string;
}) {
  return (
    <section className="as-inspector-section">
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
        {action}
      </header>
      <div className="as-inspector-section__body">{children}</div>
    </section>
  );
}

export function InspectorRow({
  label,
  mono = false,
  title,
  value,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly title?: string;
  readonly value: ReactNode;
}) {
  return (
    <dl className="as-inspector-row">
      <dt>{label}</dt>
      <dd
        className={mono ? "as-mono" : undefined}
        title={title}
      >
        {value}
      </dd>
    </dl>
  );
}

export function InspectorTabButton({
  active,
  count,
  label,
  onClick,
  tab,
}: {
  readonly active: boolean;
  readonly count?: number;
  readonly label: string;
  readonly onClick: () => void;
  readonly tab: InspectorTab;
}) {
  return (
    <button
      aria-controls="review-inspector-panel"
      aria-selected={active}
      className="as-tab"
      data-active={active}
      id={`review-inspector-tab-${tab}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
      {count === undefined ? null : <span>{count}</span>}
    </button>
  );
}

