import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconInfoCircle,
  IconShare,
  IconX,
} from "@tabler/icons-react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  api,
  type AccessSetting,
  type ArtifactDetails,
  type ArtifactVersion,
} from "@/api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccessBadge } from "./access-badge.tsx";
import { apiKeySettingsLabel, claudeCodeMcpCommand, mcpAddress, mcpAuthorizationHeader } from "./mcp-connection.ts";
import { AgentLogos } from "./share/agent-logos.tsx";
import { CopyField } from "./share/copy-field.tsx";
import { buildAgentReviewPrompt, exactReviewLink } from "./share/review-links.ts";

export { AgentLogos };

type ShareScreen = "access" | "agents" | "overview";
// Only these two copy actions show inline "Copied" state; the rest use a toast.
type InlineCopiedTarget = "agent-prompt" | "review-link";
type CopyFeedback =
  | { readonly kind: "inline"; readonly target: InlineCopiedTarget }
  | { readonly kind: "toast"; readonly message: string };

const copiedResetMilliseconds = 1_600;

interface ReviewShareControlProps {
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  /** Controlled open state, so a menu elsewhere can open Share. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
  readonly triggerSize?: "default" | "sm";
  readonly triggerVariant?: "default" | "ghost" | "outline" | "secondary";
}

/** Share one artifact from either the standard viewer header or focus controls. */
export function ReviewShareControl({
  details,
  onArtifactChanged,
  onOpenChange,
  open: openProp,
  selectedPath,
  selectedVersion,
  triggerSize = "sm",
  triggerVariant = "outline",
}: ReviewShareControlProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const [screen, setScreen] = useState<ShareScreen>("overview");
  const [selectedAccess, setSelectedAccess] = useState<AccessSetting>(
    details?.artifact.accessSetting ?? "account_required",
  );
  const [pending, setPending] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<InlineCopiedTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset on every open, including opens driven by the `open` prop, which
  // never pass through updateOpen.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setScreen("overview");
      setCopiedTarget(null);
      setFailure(null);
    }
  }

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const updateOpen = (next: boolean): void => {
    if (pending && !next) return;
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const copyText = async (
    text: string,
    failureMessage: string,
    feedback: CopyFeedback,
  ): Promise<void> => {
    setFailure(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(text);
      if (feedback.kind === "toast") {
        toast.success(feedback.message);
        return;
      }
      setCopiedTarget(feedback.target);
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(
        () => setCopiedTarget(null),
        copiedResetMilliseconds,
      );
    } catch (caught) {
      setCopiedTarget(null);
      setFailure(
        caught instanceof Error ? caught.message : failureMessage,
      );
    }
  };

  const reviewLink = selectedVersion === null
    ? null
    : exactReviewLink(selectedVersion, selectedPath);

  const copyReviewLink = async (): Promise<void> => {
    if (reviewLink === null) return;
    await copyText(
      reviewLink,
      "The exact Review link could not be copied.",
      { kind: "inline", target: "review-link" },
    );
  };

  const copyAgentPrompt = async (): Promise<void> => {
    if (details === null || selectedVersion === null || reviewLink === null) return;
    await copyText(
      buildAgentReviewPrompt(details, selectedVersion, reviewLink),
      "The agent review prompt could not be copied.",
      { kind: "inline", target: "agent-prompt" },
    );
  };

  const openAccess = (): void => {
    if (details === null) return;
    setSelectedAccess(details.artifact.accessSetting);
    setFailure(null);
    setNotice(null);
    setScreen("access");
  };

  const saveAccess = async (): Promise<void> => {
    if (details === null) return;
    if (selectedAccess === details.artifact.accessSetting) {
      setScreen("overview");
      return;
    }
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const changed = await api.changeAccess(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        selectedAccess,
        crypto.randomUUID(),
      );
      onArtifactChanged(changed.artifact);
      setNotice(
        changed.warning ?? (
          selectedAccess === "public_link"
            ? "The current version can now be opened without signing in."
            : "This artifact now requires an admitted account."
        ),
      );
      setScreen("overview");
    } catch (caught) {
      setFailure(
        caught instanceof Error ? caught.message : "Artifact access could not be changed.",
      );
    } finally {
      setPending(false);
    }
  };

  const publicArtifact = details?.artifact.accessSetting === "public_link";
  const serverOrigin = details === null ? "" : new URL(details.links.artifact).origin;
  const versionLabel = selectedVersion?.version.number ?? "—";

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger
        render={(
          <Button
            disabled={details === null || selectedVersion === null}
            size={triggerSize}
            variant={triggerVariant}
          />
        )}
      >
        <IconShare data-icon="inline-start" />
        Share
      </PopoverTrigger>
      {/* Base UI cannot see clicks inside the artifact iframe; the backdrop makes outside-press work over it. */}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
      </PopoverPrimitive.Portal>
      <PopoverContent
        align="end"
        aria-label="Share artifact"
        className="max-h-[min(44rem,calc(100dvh-1.5rem))] w-[22rem] scheme-light dark:scheme-dark gap-3 overflow-y-auto p-3"
        sideOffset={8}
      >
        <div className="flex items-start gap-2">
          {screen === "overview" ? (
            <IconFile aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ShareIconButton
              disabled={pending}
              label="Back to Share"
              onClick={() => setScreen("overview")}
            >
              <IconChevronLeft />
            </ShareIconButton>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="truncate text-sm font-medium">
              {screen === "overview"
                ? details?.artifact.name ?? "Artifact"
                : screen === "access" ? "Artifact access" : "Connect MCP"}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {screen === "overview"
                ? `Exact version · Version ${versionLabel}`
                : details?.artifact.name ?? "No artifact selected"}
            </p>
          </div>
          <ShareIconButton
            disabled={pending}
            label="Close Share"
            onClick={() => updateOpen(false)}
          >
            <IconX />
          </ShareIconButton>
        </div>

        {screen === "overview" ? (
          <>
            <Field>
              <FieldLabel htmlFor="review-share-link">Review and comment</FieldLabel>
              <CopyField
                copied={copiedTarget === "review-link"}
                copiedLabel="Copied"
                copyLabel="Copy Review link"
                disabled={reviewLink === null}
                id="review-share-link"
                onCopy={() => void copyReviewLink()}
                showText
                value={reviewLink ?? ""}
              />
            </Field>

            <Item size="xs" variant="muted">
              <ItemContent>
                <ItemTitle>
                  <AccessBadge access={publicArtifact ? "public_link" : "account_required"} />
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  People with access to this Artifact Server can review this exact version.
                  {publicArtifact ? " The latest raw artifact is public." : ""}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={details === null}
                  onClick={openAccess}
                  size="sm"
                  variant="outline"
                >
                  Manage access
                </Button>
              </ItemActions>
            </Item>

            <Separator />

            <FieldGroup className="gap-3">
              <h3 className="text-xs font-medium text-muted-foreground">Other links</h3>
              <Field>
                <FieldContent>
                  <FieldLabel htmlFor="review-share-latest">Latest</FieldLabel>
                  <FieldDescription>Moves when a new version is published</FieldDescription>
                </FieldContent>
                <CopyField
                  copyLabel="Copy latest link"
                  disabled={details === null}
                  id="review-share-latest"
                  onCopy={() => {
                    if (details !== null) {
                      void copyText(
                        details.links.artifact,
                        "The latest artifact link could not be copied.",
                        { kind: "toast", message: "Link copied" },
                      );
                    }
                  }}
                  value={details?.links.artifact ?? ""}
                />
              </Field>
              <Field>
                <FieldContent>
                  <FieldLabel htmlFor="review-share-raw">Raw</FieldLabel>
                  <FieldDescription>Exact version without Review controls</FieldDescription>
                </FieldContent>
                <CopyField
                  copyLabel="Copy raw link"
                  disabled={selectedVersion === null}
                  id="review-share-raw"
                  onCopy={() => {
                    if (selectedVersion !== null) {
                      void copyText(
                        selectedVersion.links.version,
                        "The raw version link could not be copied.",
                        { kind: "toast", message: "Link copied" },
                      );
                    }
                  }}
                  value={selectedVersion?.links.version ?? ""}
                />
              </Field>
            </FieldGroup>

            <Separator />

            <section aria-labelledby="review-share-agent-heading" className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium" id="review-share-agent-heading">
                  Review with an AI agent
                </h3>
                <p className="text-xs text-muted-foreground">
                  Copy one complete prompt into Claude, Codex, Cursor, GitHub Copilot, Pi, or OpenCode.
                </p>
              </div>
              <Button
                className="w-full justify-start"
                disabled={details === null || selectedVersion === null}
                onClick={() => void copyAgentPrompt()}
                variant="outline"
              >
                <AgentLogos />
                <span className="flex-1 text-left">
                  {copiedTarget === "agent-prompt" ? "Prompt copied" : "Copy review prompt"}
                </span>
                {copiedTarget === "agent-prompt"
                  ? <IconCheck data-icon="inline-end" />
                  : <IconCopy data-icon="inline-end" />}
              </Button>
              <Button
                className="w-full justify-between"
                disabled={details === null}
                onClick={() => {
                  setFailure(null);
                  setScreen("agents");
                }}
                variant="ghost"
              >
                Connect MCP
                <IconChevronRight data-icon="inline-end" />
              </Button>
            </section>

            {failure === null ? null : <ShareFailure message={failure} />}
            {notice === null ? null : (
              <Alert role="status">
                <IconInfoCircle />
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}

            <p className="text-xs text-muted-foreground">
              This Review link stays pinned to Version {versionLabel}
              {selectedPath === null ? "." : ` and ${selectedPath}.`}
            </p>
          </>
        ) : screen === "agents" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connect over MCP with an API key from {apiKeySettingsLabel}.
            </p>
            <ItemGroup className="gap-2">
              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <span>Claude Code</span>
                    <Badge variant="secondary">MCP</Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    Run this, replacing &lt;key&gt; with your API key.
                  </ItemDescription>
                </ItemContent>
                <ItemFooter>
                  <CopyField
                    copyLabel="Copy Claude Code command"
                    inputLabel="Claude Code command"
                    onCopy={() => void copyText(
                      claudeCodeMcpCommand(serverOrigin),
                      "The Claude Code command could not be copied.",
                      { kind: "toast", message: "Command copied" },
                    )}
                    value={claudeCodeMcpCommand(serverOrigin)}
                  />
                </ItemFooter>
              </Item>

              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <span>Codex, Cursor, and other clients</span>
                    <Badge variant="secondary">MCP</Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    Add this address as a remote HTTP MCP server with the header <code>{mcpAuthorizationHeader}</code>.
                  </ItemDescription>
                </ItemContent>
                <ItemFooter>
                  <CopyField
                    copyLabel="Copy MCP server address"
                    inputLabel="MCP server address"
                    onCopy={() => void copyText(
                      mcpAddress(serverOrigin),
                      "The MCP server address could not be copied.",
                      { kind: "toast", message: "Address copied" },
                    )}
                    value={mcpAddress(serverOrigin)}
                  />
                </ItemFooter>
              </Item>

              <Item variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <span>Without MCP</span>
                    <Badge variant="secondary">HTTP API</Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    The review prompt includes an exact authenticated API request for this version. Use a scoped API key from an administrator and never paste it into chat.
                  </ItemDescription>
                </ItemContent>
                </Item>
            </ItemGroup>

            {failure === null ? null : <ShareFailure message={failure} />}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Choose who can open the current version from the stable artifact link.
            </p>
            <RadioGroup
              aria-label="Who can open this artifact"
              disabled={pending}
              onValueChange={(value) => {
                if (value === "account_required" || value === "public_link") {
                  setSelectedAccess(value);
                }
              }}
              value={selectedAccess}
            >
              <ShareAccessOption
                description="An admitted installation account is required."
                label="Private"
                value="account_required"
              />
              <ShareAccessOption
                description="No sign-in. Anyone who can reach this server and has the link can open the current version."
                label="Public link"
                value="public_link"
              />
            </RadioGroup>
            <Alert role="note">
              <IconInfoCircle />
              <AlertDescription>
                Public access does not create a tunnel, open a firewall, or make an unreachable server reachable.
              </AlertDescription>
            </Alert>
            {selectedAccess !== details?.artifact.accessSetting ? (
              <Alert role="note">
                <IconAlertTriangle />
                <AlertDescription>
                  {selectedAccess === "public_link"
                    ? "The link can be redistributed. Earlier versions and history stay account-required."
                    : "Downloaded or externally cached copies cannot be recalled."}
                </AlertDescription>
              </Alert>
            ) : null}
            {failure === null ? null : <ShareFailure message={failure} />}
            <div className="flex justify-end gap-2">
              <Button
                disabled={pending}
                onClick={() => setScreen("overview")}
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  details === null
                  || pending
                  || selectedAccess === details.artifact.accessSetting
                }
                onClick={() => void saveAccess()}
              >
                {pending ? <Spinner data-icon="inline-start" /> : null}
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ShareIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ShareFailure({ message }: { readonly message: string }) {
  return (
    <Alert variant="destructive">
      <IconAlertTriangle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function ShareAccessOption({
  description,
  label,
  value,
}: {
  readonly description: string;
  readonly label: string;
  readonly value: AccessSetting;
}) {
  const id = `review-share-access-${value}`;
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>{label}</FieldTitle>
          <FieldDescription>{description}</FieldDescription>
        </FieldContent>
        <RadioGroupItem id={id} value={value} />
      </Field>
    </FieldLabel>
  );
}
