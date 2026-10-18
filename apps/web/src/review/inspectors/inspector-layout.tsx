import {Children, Fragment, isValidElement, type ReactNode} from "react";

import {Badge} from "@/components/ui/badge";
import {Separator} from "@/components/ui/separator";
import {cn} from "@/lib/utils";

export type InspectorTab = "activity" | "comments" | "compare" | "details" | "files" | "versions";

/** Stack inspector sections with a hairline between each pair. */
export function InspectorStack({children}: {readonly children: ReactNode}) {
  const sections = Children.toArray(children);
  return (
    <div className="flex flex-col gap-3">
      {sections.map((section, index) => (
        <Fragment key={isValidElement(section) && section.key !== null ? section.key : index}>
          {index === 0 ? null : <Separator />}
          {section}
        </Fragment>
      ))}
    </div>
  );
}

export function InspectorSection({
  action,
  children,
  count,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  /** How many items the section lists; omitted when it is a fixed set of fields. */
  readonly count?: number;
  readonly title: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex min-h-7 items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {count === undefined ? null : <Badge variant="secondary">{count}</Badge>}
        {action === undefined || action === null ? null : <div className="ml-auto">{action}</div>}
      </header>
      <div className="flex flex-col gap-2">{children}</div>
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
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn("m-0 min-w-0", mono ? "truncate font-mono text-xs" : "wrap-break-word")}
        title={title}
      >
        {value}
      </dd>
    </dl>
  );
}

