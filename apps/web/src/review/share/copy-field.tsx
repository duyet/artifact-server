import { IconCheck, IconCopy } from "@tabler/icons-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

/** Read-only value with a copy button; the button reads "Copy" or "Copied" when `showText` is set. */
export function CopyField({
  copied = false,
  copiedLabel,
  copyLabel,
  disabled = false,
  id,
  inputLabel,
  onCopy,
  showText = false,
  value,
}: {
  readonly copied?: boolean;
  readonly copiedLabel?: string;
  readonly copyLabel: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly inputLabel?: string;
  readonly onCopy: () => void;
  readonly showText?: boolean;
  readonly value: string;
}) {
  const CopyIcon = copied ? IconCheck : IconCopy;
  return (
    <InputGroup>
      <InputGroupInput
        aria-label={inputLabel}
        className="font-mono text-xs"
        id={id}
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        title={value}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label={copied && copiedLabel !== undefined ? copiedLabel : copyLabel}
          disabled={disabled}
          onClick={onCopy}
          size={showText ? "xs" : "icon-xs"}
          variant={showText ? "secondary" : "ghost"}
        >
          <CopyIcon data-icon={showText ? "inline-start" : undefined} />
          {showText ? (copied ? "Copied" : "Copy") : null}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
