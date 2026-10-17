import type {ArtifactOwner} from "@/api/client";
import {Avatar, AvatarFallback} from "@/components/ui/avatar";

/** A readable name for a principal; "You" for the signed-in one. */
export function principalLabel(identity: ArtifactOwner, viewerPrincipalId: string): string {
  if (identity.principalId === viewerPrincipalId) return "You";
  return identity.displayName ?? identity.principalId;
}

/** One or two capital letters for an avatar fallback. */
export function principalInitials(identity: ArtifactOwner): string {
  const words = (identity.displayName ?? "").split(/\s+/u).filter((word) => word !== "");
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
  return initials === "" ? (identity.principalId.replace(/^[a-z]+_/u, "")[0]?.toUpperCase() ?? "?") : initials;
}

/** A small avatar with the principal's initials. */
export function OwnerAvatar({
  className,
  identity,
  size = "sm",
}: {
  readonly className?: string;
  readonly identity: ArtifactOwner;
  readonly size?: "default" | "sm";
}) {
  return (
    <Avatar className={className} size={size}>
      <AvatarFallback>{principalInitials(identity)}</AvatarFallback>
    </Avatar>
  );
}
