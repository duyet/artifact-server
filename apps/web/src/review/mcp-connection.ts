/**
 * How a coding agent connects to this server: the MCP endpoint with an API key
 * sent as a bearer token. Every connection hint in the app reads from here.
 */

/** Where an API key is created; administrators manage keys. */
export const apiKeySettingsLabel = "Settings › API keys";

/** The header every MCP client sends; `<key>` is the API key. */
export const mcpAuthorizationHeader = "Authorization: Bearer <key>";

/** The server's MCP endpoint. */
export function mcpAddress(origin: string): string {
  return `${origin}/mcp`;
}

/** The Claude Code command that registers this server with an API key. */
export function claudeCodeMcpCommand(origin: string): string {
  return `claude mcp add --transport http artifact-server ${mcpAddress(origin)} --header "${mcpAuthorizationHeader}"`;
}

/** One sentence that tells an agent how to connect, for copyable prompts. */
export function mcpConnectionInstructions(origin: string): string {
  return `Connect to the MCP server ${mcpAddress(origin)} with an Artifact Server API key (create one under ${apiKeySettingsLabel}). Claude Code: ${claudeCodeMcpCommand(origin)}. Codex and Cursor: add ${mcpAddress(origin)} as a remote HTTP MCP server with the header ${mcpAuthorizationHeader}.`;
}
