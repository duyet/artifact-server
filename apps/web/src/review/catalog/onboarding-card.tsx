import {useState} from "react";
import {IconCheck, IconCopy, IconPlugConnected, IconSettings, IconX} from "@tabler/icons-react";
import {toast} from "sonner";

import {Button, ButtonLink} from "@/components/ui/button";
import {Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle} from "@/components/ui/card";
import {InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea} from "@/components/ui/input-group";
import {mcpConnectionInstructions} from "../mcp-connection.ts";
import {mcpSettingsPath} from "../review-routes.ts";

const dismissedKey = "artifact-review-onboarding-dismissed";

/** The prompt a coding agent needs to connect over MCP and publish here. */
export function agentConnectionPrompt(origin: string, projectId: string): string {
  return `Connect to my Artifact Server and use it to publish and share finished work.

1. ${mcpConnectionInstructions(origin)}
2. Call artifact_capabilities to learn this installation's limits, then project_list. Use project "${projectId}" unless I name another.
3. To publish, upload the real files with artifact_create_upload, PUT each file, then artifact_commit_upload. To update, call artifact_get first and pass its current version as expectedCurrentVersionId.
4. After publishing, give me links.review first so I can read and comment. Use artifact_set_visibility only when I ask to share a public link.

Never paste the API key into chat.`;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(dismissedKey) === "true";
  } catch {
    return false;
  }
}

/** First-run guidance for connecting a coding agent, until dismissed. */
export function OnboardingCard({projectId}: {readonly projectId: string}) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [copied, setCopied] = useState(false);
  if (dismissed) return null;
  const prompt = agentConnectionPrompt(window.location.origin, projectId);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      toast.success("Prompt copied");
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      toast.error("The prompt could not be copied.");
    }
  };
  const dismiss = (): void => {
    try {
      window.localStorage.setItem(dismissedKey, "true");
    } catch {
      // Dismissal still holds for this page when storage is unavailable.
    }
    setDismissed(true);
  };

  return (
    <Card aria-labelledby="review-onboarding-title" role="region" size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2" id="review-onboarding-title">
          <IconPlugConnected className="size-4 text-muted-foreground" />
          Connect your coding agent
        </CardTitle>
        <CardDescription>
          Paste this into Claude Code, Codex, or Cursor. It connects over MCP, then publishes and shares artifacts here.
        </CardDescription>
        <CardAction>
          <Button aria-label="Dismiss" onClick={dismiss} size="icon-sm" variant="ghost">
            <IconX />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <InputGroup>
          <InputGroupTextarea
            aria-label="Agent connection prompt"
            className="max-h-24 font-mono text-xs md:text-xs"
            readOnly
            value={prompt}
          />
          <InputGroupAddon align="block-end">
            <InputGroupButton className="ml-auto" onClick={() => void copy()} size="sm" variant="secondary">
              {copied ? <IconCheck data-icon="inline-start" /> : <IconCopy data-icon="inline-start" />}
              {copied ? "Copied" : "Copy prompt"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </CardContent>
      <CardFooter>
        <ButtonLink href={mcpSettingsPath} size="sm" variant="outline">
          <IconSettings data-icon="inline-start" />
          Settings › MCP and API keys
        </ButtonLink>
      </CardFooter>
    </Card>
  );
}
