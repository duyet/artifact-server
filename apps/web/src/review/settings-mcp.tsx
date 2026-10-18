import { IconCheck, IconCopy } from "@tabler/icons-react";
import {useEffect, useRef, useState} from "react";
import {toast} from "sonner";

import {PageHeader} from "@/components/product";
import {Badge} from "@/components/ui/badge";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {InputGroup, InputGroupAddon} from "@/components/ui/input-group";
import {claudeCodeMcpCommand, mcpAddress, mcpAuthorizationHeader} from "./mcp-connection.ts";

type CopyTarget = "claude" | "remote" | "skill";

const copiedResetMilliseconds = 1_600;

/** Explain the supported local and team MCP connection paths for this installation. */
export function McpScreen({administrator}: {readonly administrator: boolean}) {
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = window.location.origin;

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const copy = async (value: string, target: CopyTarget): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(value);
      setCopiedTarget(target);
      toast.success("Copied to clipboard.");
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(
        () => setCopiedTarget(null),
        copiedResetMilliseconds,
      );
    } catch {
      setCopiedTarget(null);
      toast.error("Unable to copy. Select the value and copy it manually.");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        description="Give your coding agent (Codex, Claude Code, Cursor, VS Code) authenticated access to projects, artifacts, versions, and comments. Every client connects to the same address with an API key sent as a bearer token."
        eyebrow="Connections"
        title="Connect agents with MCP"
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <ConnectionCard
          badge="Claude Code"
          description="Run this in a terminal, replacing <key> with an API key."
          title="Add the server to Claude Code"
        >
          <CopyableValue
            copied={copiedTarget === "claude"}
            label="Copy Claude Code command"
            onCopy={() => void copy(claudeCodeMcpCommand(origin), "claude")}
            value={claudeCodeMcpCommand(origin)}
          />
        </ConnectionCard>

        <ConnectionCard
          badge="Codex, Cursor, VS Code"
          description="Add this address as a remote HTTP MCP server in the client’s MCP settings."
          title="Connect with the server address"
        >
          <CopyableValue
            copied={copiedTarget === "remote"}
            label="Copy MCP server address"
            onCopy={() => void copy(mcpAddress(origin), "remote")}
            value={mcpAddress(origin)}
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            Send the header <code>{mcpAuthorizationHeader}</code>. Administrators create API keys;
            never paste a key into chat.
          </p>
          {administrator ? (
            <ButtonLink className="self-start" href="/review/settings/api-keys" size="xs" variant="outline">
              Manage API keys
            </ButtonLink>
          ) : null}
        </ConnectionCard>
      </div>

      <Card role="region" aria-labelledby="mcp-agent-skill">
        <CardHeader>
          <CardTitle aria-level={2} id="mcp-agent-skill" role="heading">
            Give agents the Artifact Server skill
          </CardTitle>
          <CardDescription>
            The optional skill teaches an agent to use MCP for server data and the CLI for files
            on its computer. Artifact bytes are never copied into MCP tool arguments.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">Optional</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <CopyableValue
            copied={copiedTarget === "skill"}
            label="Copy skill installation command"
            onCopy={() => void copy("npx skills add plannotator/artifact-server", "skill")}
            value="npx skills add plannotator/artifact-server"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionCard({
  badge,
  children,
  description,
  title,
}: {
  readonly badge: string;
  readonly children: React.ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle aria-level={2} role="heading">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="secondary">{badge}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="mt-auto flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function CopyableValue({
  copied,
  label,
  onCopy,
  value,
}: {
  readonly copied: boolean;
  readonly label: string;
  readonly onCopy: () => void;
  readonly value: string;
}) {
  return (
    <InputGroup className="h-auto">
      <InputGroupAddon className="min-w-0 flex-1 cursor-auto justify-start py-2">
        <code className="font-mono text-xs break-all text-foreground">{value}</code>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <Button
          aria-label={copied ? "Copied" : label}
          onClick={onCopy}
          size="xs"
          type="button"
          variant="ghost"
        >
          {copied ? <IconCheck data-icon="inline-start" /> : <IconCopy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
