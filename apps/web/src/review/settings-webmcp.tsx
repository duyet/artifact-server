import {PageHeader} from "@/components/product";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {WebmcpSettingsCard} from "./webmcp.tsx";

/** Configure browser-provided Review tools independently from external MCP clients. */
export function WebmcpScreen() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        description="Let an AI agent running in this browser operate Review through browser-provided tools. This is separate from connecting external coding agents through MCP."
        eyebrow="Browser tools"
        title="WebMCP"
      />

      <Card role="region" aria-labelledby="webmcp-review-tools">
        <CardHeader>
          <CardTitle aria-level={2} id="webmcp-review-tools" role="heading">Review tools</CardTitle>
          <CardDescription>
            This preference applies to this browser profile. It does not change MCP connections
            in Codex, Claude Code, Cursor, VS Code, or other clients.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebmcpSettingsCard />
        </CardContent>
      </Card>
    </div>
  );
}
