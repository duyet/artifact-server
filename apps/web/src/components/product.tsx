import type { ReactNode } from "react";

import { ApiError } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/presentation";

/** Primary heading and actions for a management screen. */
export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  readonly actions?: ReactNode;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly title: string;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow === undefined ? null : (
          <p className="font-mono text-xs font-medium tracking-widest text-muted-foreground uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-heading text-2xl leading-tight font-semibold tracking-tight text-balance">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            {description}
          </p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      )}
    </header>
  );
}

/** Intentional loading, empty, forbidden, and unavailable screen state. */
export function StatePanel({
  action,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <Empty className="min-h-56 border">
      <EmptyHeader>
        <EmptyTitle aria-level={2} role="heading">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** Expected request failure with distinct authentication and permission treatment. */
export function ErrorPanel({
  error,
  onRetry,
}: {
  readonly error: Error;
  readonly onRetry?: () => void;
}) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const conflict = error instanceof ApiError && (
    error.code === "ARTIFACT_MUTATION_CONFLICT"
    || error.code === "PUBLISH_CONFLICT"
  );
  const title = forbidden
    ? "Permission required"
    : conflict
      ? "Artifact changed"
      : "Request failed";
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error)}</p>
        {onRetry === undefined ? null : (
          <Button className="mt-2" onClick={onRetry} size="sm" type="button" variant="outline">
            {conflict ? "Reload artifact" : "Try again"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Compact product status label. */
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "danger" | "neutral" | "primary";
}) {
  return (
    <Badge variant={tone === "danger" ? "destructive" : tone === "primary" ? "default" : "secondary"}>
      {children}
    </Badge>
  );
}

/** Label-value metadata row that tolerates long identifiers. */
export function MetadataRow({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

/** Inline-start spinner for a pending button; hidden so it never changes the button's accessible name. */
export function ButtonSpinner() {
  return <Spinner aria-hidden="true" data-icon="inline-start" role="presentation" />;
}
