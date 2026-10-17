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

type CopyTarget = "doctor" | "local" | "remote" | "skill";

const copiedResetMilliseconds = 1_600;

/** Explain the supported local and team MCP connection paths for this installation. */
export function McpScreen({administrator}: {readonly administrator: boolean}) {
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mcpAddress = `${window.location.origin}/mcp`;

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
        description="Give your coding agent (Codex, Claude Code, Cursor, VS Code) authenticated access to projects, artifacts, versions, and comments. Choose the setup that matches where Artifact Server runs."
        eyebrow="Connections"
        title="Connect agents with MCP"
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <ConnectionCard
          badge="Local installation"
          description="Run this on the computer where Artifact Server and your AI client are installed. It detects Codex, Claude Code, Cursor, or VS Code, updates the client configuration, and verifies the connection."
          title="Connect automatically"
        >
          <CopyableValue
            copied={copiedTarget === "local"}
            label="Copy local connection command"
            onCopy={() => void copy("artifactserver connect", "local")}
            value="artifactserver connect"
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            If more than one supported client is installed, add its name: <code>codex</code>,{" "}
            <code>claude</code>, <code>cursor</code>, or <code>vscode</code>.
          </p>
        </ConnectionCard>

        <ConnectionCard
          badge="Team or remote server"
          description="Add this exact address in your client’s MCP settings. The client should open browser sign-in when it connects."
          title="Connect with the server address"
        >
          <CopyableValue
            copied={copiedTarget === "remote"}
            label="Copy MCP server address"
            onCopy={() => void copy(mcpAddress, "remote")}
            value={mcpAddress}
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            If the client cannot use browser authentication, ask an administrator for a scoped
            API key. Never paste a key into chat.
          </p>
          {administrator ? (
            <ButtonLink className="self-start" href="/review/settings/api-keys" size="xs" variant="outline">
              Manage API keys
            </ButtonLink>
          ) : null}
        </ConnectionCard>
      </div>

      <Card role="region" aria-labelledby="mcp-after-connection">
        <CardHeader>
          <CardTitle aria-level={2} id="mcp-after-connection" role="heading">
            Check the connection
          </CardTitle>
          <CardDescription>
            Inspect the managed service and client registration without changing either one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CopyableValue
            copied={copiedTarget === "doctor"}
            label="Copy connection check command"
            onCopy={() => void copy("artifactserver doctor", "doctor")}
            value="artifactserver doctor"
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            To remove a managed local connection, run <code>artifactserver disconnect</code>.
          </p>
        </CardContent>
      </Card>

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
    <InputGroup>
      <InputGroupAddon className="min-w-0 flex-1 cursor-auto justify-start overflow-x-auto">
        <code className="font-mono text-xs whitespace-nowrap text-foreground">{value}</code>
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
