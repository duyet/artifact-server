import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * Bounded comment body editor.
 *
 * One mounted composer is one compose attempt: its idempotency key is minted
 * on the first submission and reused for every retry until the server accepts
 * the text, so a retried create can never duplicate a comment.
 */
export function CommentComposer({
  cancelLabel,
  draftRestored = false,
  initialBody,
  inputId,
  label,
  maximumCharacters,
  onBodyChange,
  onCancel,
  onDiscardDraft,
  onSubmit,
  submitLabel,
}: {
  readonly cancelLabel: string | null;
  /** True when `initialBody` came out of the draft store, not the caller. */
  readonly draftRestored?: boolean;
  readonly initialBody: string;
  readonly inputId: string;
  readonly label: string;
  readonly maximumCharacters: number;
  /** Draft wiring: hears every edit, including the clearing submit/discard. */
  readonly onBodyChange?: (body: string) => void;
  readonly onCancel: (() => void) | null;
  readonly onDiscardDraft?: () => void;
  readonly onSubmit: (body: string, idempotencyKey: string) => Promise<boolean>;
  readonly submitLabel: string;
}) {
  const [body, setBody] = useState(initialBody);
  const [pending, setPending] = useState(false);
  const attemptKey = useRef<string | null>(null);
  const trimmed = body.trim();
  const tooLong = trimmed.length > maximumCharacters;

  const submit = async () => {
    if (trimmed === "" || tooLong) return;
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    const accepted = await onSubmit(trimmed, attemptKey.current);
    setPending(false);
    if (!accepted) return;
    attemptKey.current = null;
    setBody("");
    onBodyChange?.("");
  };

  const discardDraft = () => {
    setBody("");
    onDiscardDraft?.();
  };

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
        {draftRestored && trimmed !== "" ? (
          <span className="flex items-center gap-1">
            <Badge data-draft-marker variant="outline">
              Draft
            </Badge>
            {onDiscardDraft === undefined ? null : (
              <Button onClick={discardDraft} size="xs" type="button" variant="ghost">
                Discard
              </Button>
            )}
          </span>
        ) : null}
      </div>
      <Textarea
        aria-describedby={tooLong ? `${inputId}-limit` : undefined}
        aria-invalid={tooLong}
        className="min-h-20"
        disabled={pending}
        id={inputId}
        onChange={(event) => {
          setBody(event.currentTarget.value);
          onBodyChange?.(event.currentTarget.value);
        }}
        placeholder="Describe what should change and why."
        value={body}
      />
      {tooLong
        ? (
          <FieldError id={`${inputId}-limit`}>
            {`A comment holds at most ${maximumCharacters} characters. Remove ${
              trimmed.length - maximumCharacters
            }.`}
          </FieldError>
        )
        : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={pending || trimmed === "" || tooLong}
          onClick={() => void submit()}
          size="xs"
          type="button"
        >
          {pending ? <Spinner aria-hidden data-icon="inline-start" /> : null}
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel === null || cancelLabel === null
          ? null
          : (
            <Button
              disabled={pending}
              onClick={onCancel}
              size="xs"
              type="button"
              variant="ghost"
            >
              {cancelLabel}
            </Button>
          )}
      </div>
    </Field>
  );
}
