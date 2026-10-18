import type {ArtifactOwner} from "@/api/client";
import {Avatar, AvatarFallback} from "@/components/ui/avatar";
import {principalInitials} from "./principal-name.ts";

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
