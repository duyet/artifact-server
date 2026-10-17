import type {ArtifactDetails, ArtifactVersion} from "@/api/client";

export function exactReviewLink(
  selectedVersion: ArtifactVersion,
  selectedPath: string | null,
): string {
  const reviewUrl = new URL(selectedVersion.links.review);
  reviewUrl.searchParams.set("view", "focus");
  if (
    selectedPath !== null
    && selectedVersion.manifest.entries.some((entry) => entry.path === selectedPath)
  ) {
    reviewUrl.searchParams.set("path", selectedPath);
  } else {
    reviewUrl.searchParams.delete("path");
  }
  return reviewUrl.toString();
}

export function buildAgentReviewPrompt(
  details: ArtifactDetails,
  selectedVersion: ArtifactVersion,
  reviewLink: string,
): string {
  const serverOrigin = new URL(details.links.artifact).origin;
  const apiUrl = new URL(
    `/api/v1/artifacts/${encodeURIComponent(details.artifact.id)}/versions/${encodeURIComponent(selectedVersion.version.id)}`,
    serverOrigin,
  );
  apiUrl.searchParams.set("projectId", details.artifact.projectId);
  const manifestResource = `artifact://projects/${details.artifact.projectId}/artifacts/${details.artifact.id}/versions/${selectedVersion.version.id}/manifest`;

  return `Review this Artifact Server artifact. Inspect the exact saved version below and do not silently substitute a newer version.

Artifact: ${details.artifact.name}
Project ID: ${details.artifact.projectId}
Artifact ID: ${details.artifact.id}
Version: ${selectedVersion.version.number}
Version ID: ${selectedVersion.version.id}
Access: ${details.artifact.accessSetting === "public_link" ? "public link" : "private"}
Review and comment: ${reviewLink}
Raw exact version: ${selectedVersion.links.version}
Moving latest link: ${details.links.artifact}

Preferred path — Artifact Server MCP:
1. Call artifact_get with projectId "${details.artifact.projectId}" and artifactId "${details.artifact.id}".
2. Keep versionId "${selectedVersion.version.id}" pinned. If artifact_get reports a different current version, use artifact_version_list and review the pinned version instead.
3. Read the exact manifest resource when available: ${manifestResource}
4. Use artifact_open.reviewUrl for the full-screen Review experience. Use artifact_open.browserUrl only when you need the raw rendered artifact.
5. Review the artifact and report findings in priority order. When comment tools are available, use comment_create against this exact version for precise, actionable findings.

If Artifact Server MCP is not connected:
- Local setup: run artifactserver connect, then retry with MCP.
- Remote or team setup: add ${serverOrigin}/mcp to the agent and complete browser sign-in, or use an administrator-issued scoped key when OAuth is unavailable.
- Direct HTTP fallback: GET ${apiUrl.toString()} with an admitted session or scoped API key.
- curl example: curl --fail-with-body --header "Authorization: Bearer $ARTIFACT_SERVER_API_KEY" '${apiUrl.toString()}'

Never paste credentials into chat, source files, or the review. If access fails, state which connection or permission is missing.`;
}
