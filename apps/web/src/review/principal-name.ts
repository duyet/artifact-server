import type {ArtifactOwner} from "@/api/client";

/**
 * A readable name for a principal. Writes made before names were recorded
 * carry only the principal ID, so its shape names the kind of credential.
 */
export function principalName(identity: ArtifactOwner): string {
  if (identity.displayName !== null) return identity.displayName;
  const id = identity.principalId;
  if (id === "local-api-token") return "Local API token";
  if (id.startsWith("service:")) return "API key";
  if (id.startsWith("member_")) return `Member ${id.slice("member_".length, "member_".length + 8)}`;
  return id;
}

/** {@link principalName}, but "You" for the signed-in principal. */
export function principalLabel(identity: ArtifactOwner, viewerPrincipalId: string): string {
  return identity.principalId === viewerPrincipalId ? "You" : principalName(identity);
}

/** One or two capital letters for an avatar fallback. */
export function principalInitials(identity: ArtifactOwner): string {
  const words = principalName(identity).split(/[\s_:-]+/u).filter((word) => word !== "");
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "?";
}
