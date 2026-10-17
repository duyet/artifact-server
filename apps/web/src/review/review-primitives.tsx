import type {ReactNode} from "react";
import {IconFileSearch} from "@tabler/icons-react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from "@/components/ui/empty";
import {Kbd} from "@/components/ui/kbd";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import {ArtifactMark} from "./artifact-mark.tsx";

/** An icon-only button whose label shows as a tooltip, with its shortcut. */
export function IconButton({
  active,
  children,
  disabled = false,
  keyShortcuts,
  label,
  onClick,
  shortcut,
}: {
  readonly active?: boolean;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  /** The `aria-keyshortcuts` value, such as "Meta+\\ Control+\\". */
  readonly keyShortcuts?: string;
  readonly label: string;
  readonly onClick: () => void;
  /** The key to show in the tooltip, such as "]". */
  readonly shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            aria-keyshortcuts={keyShortcuts}
            aria-label={label}
            aria-pressed={active}
            data-active={active}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant={active === true ? "secondary" : "ghost"}
          />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The viewer's state before an artifact or version is readable. */
export function PreviewWelcome({
  description = "Choose an artifact to inspect its current immutable version.",
  title = "Select an artifact",
}: {
  readonly description?: string;
  readonly title?: string;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><IconFileSearch /></EmptyMedia>
        <EmptyTitle aria-level={2} role="heading">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A full-page sign-in, loading, or failure state shown before the shell. */
export function ReviewGate({
  action,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <ArtifactMark className="mb-2 size-9" />
          <CardDescription>Artifact Server</CardDescription>
          <CardTitle aria-level={1} role="heading">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {action === undefined ? null : <CardContent>{action}</CardContent>}
      </Card>
    </main>
  );
}
