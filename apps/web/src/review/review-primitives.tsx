import {IconLink} from "@tabler/icons-react";

import type {ArtifactDetails} from "@/api/client";

export function IconButton({
  active,
  children,
  disabled = false,
  keyShortcuts,
  label,
  onClick,
  title,
}: {
  readonly active?: boolean;
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly keyShortcuts?: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly title?: string;
}) {
  return (
    <button
      aria-keyshortcuts={keyShortcuts}
      aria-label={label}
      aria-pressed={active}
      className="as-icon-button"
      data-active={active}
      disabled={disabled}
      onClick={onClick}
      title={title ?? label}
      type="button"
    >
      {children}
    </button>
  );
}

export function AccessPill({access}: {readonly access: ArtifactDetails["artifact"]["accessSetting"]}) {
  return (
    <span className="as-pill" data-access={access}>
      {access === "public_link" ? "public" : "private"}
    </span>
  );
}

export function PreviewWelcome({
  description = "Choose an artifact from the catalog to inspect its current immutable version.",
  title = "Select an artifact",
}: {
  readonly description?: string;
  readonly title?: string;
}) {
  return (
    <div className="as-preview-welcome">
      <span aria-hidden="true"><IconLink stroke={1.4} /></span>
      <p>Immutable artifact workspace</p>
      <h2>{title}</h2>
      <small>{description}</small>
    </div>
  );
}

export function InlineState({
  description,
  title,
  tone = "neutral",
}: {
  readonly description: string;
  readonly title: string;
  readonly tone?: "error" | "neutral";
}) {
  return (
    <div className="as-inline-state" data-tone={tone} role="status">
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function ReviewGate({
  action,
  description,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <main className="as-gate">
      <section>
        <span aria-hidden="true" className="as-gate__mark">A</span>
        <p>Artifact Server</p>
        <h1>{title}</h1>
        <small>{description}</small>
        {action}
      </section>
    </main>
  );
}

