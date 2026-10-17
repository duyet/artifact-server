import { cn } from "@/lib/utils";
import claudeLogoUrl from "../assets/agents/claude.svg";
import codexDarkLogoUrl from "../assets/agents/codex-dark.svg";
import codexLightLogoUrl from "../assets/agents/codex-light.svg";
import copilotDarkLogoUrl from "../assets/agents/copilot-dark.svg";
import copilotLightLogoUrl from "../assets/agents/copilot-light.svg";
import cursorDarkLogoUrl from "../assets/agents/cursor-dark.svg";
import cursorLightLogoUrl from "../assets/agents/cursor-light.svg";
import opencodeDarkLogoUrl from "../assets/agents/opencode-dark.svg";
import opencodeLightLogoUrl from "../assets/agents/opencode-light.svg";
import piLogoUrl from "../assets/agents/pi.svg";
import piLightLogoUrl from "../assets/agents/pi-light.svg";

const logoClassName = "relative inline-block size-4 shrink-0";
const logoImageClassName = "absolute inset-0 block size-full object-contain";

/** Row of supported coding agents. Pass `className` to resize via `[&_[data-slot=agent-logo]]:size-*`. */
export function AgentLogos({ className }: { readonly className?: string }) {
  return (
    <span
      aria-label="Claude, Codex, Cursor, GitHub Copilot, Pi, and OpenCode"
      className={cn("inline-flex items-center gap-1.5", className)}
      role="img"
    >
      <span aria-hidden="true" className={logoClassName} data-slot="agent-logo">
        <img alt="" className={logoImageClassName} src={claudeLogoUrl} />
      </span>
      <ThemedAgentLogo darkUrl={codexDarkLogoUrl} lightUrl={codexLightLogoUrl} />
      <ThemedAgentLogo darkUrl={cursorDarkLogoUrl} lightUrl={cursorLightLogoUrl} />
      <ThemedAgentLogo darkUrl={copilotDarkLogoUrl} lightUrl={copilotLightLogoUrl} />
      <ThemedAgentLogo darkUrl={piLogoUrl} lightUrl={piLightLogoUrl} />
      <ThemedAgentLogo darkUrl={opencodeDarkLogoUrl} lightUrl={opencodeLightLogoUrl} />
    </span>
  );
}

function ThemedAgentLogo({
  darkUrl,
  lightUrl,
}: {
  readonly darkUrl: string;
  readonly lightUrl: string;
}) {
  return (
    <span aria-hidden="true" className={logoClassName} data-slot="agent-logo">
      <img
        alt=""
        className={cn(logoImageClassName, "hidden dark:block")}
        data-agent-theme="dark"
        src={darkUrl}
      />
      <img
        alt=""
        className={cn(logoImageClassName, "block dark:hidden")}
        data-agent-theme="light"
        src={lightUrl}
      />
    </span>
  );
}
