import {createContext, use, type ReactNode} from "react";

import type {ArtifactOwner} from "@/api/client";
import {HoverCard, HoverCardContent, HoverCardTrigger} from "@/components/ui/hover-card";
import {OwnerAvatar} from "./owner-avatar.tsx";
import {principalKindLabel, principalLabel} from "./principal-name.ts";

/** Artifacts owned per principal in this project; null when not known. */
export const OwnerCountsContext = createContext<ReadonlyMap<string, number> | null>(null);

/**
 * Wrap who made an artifact so hovering or focusing it explains the principal:
 * name, credential kind, and how many artifacts they own, when that is known.
 */
export function OwnerHoverCard({
  children,
  identity,
  viewerPrincipalId,
}: {
  readonly children: ReactNode;
  readonly identity: ArtifactOwner;
  readonly viewerPrincipalId: string;
}) {
  const kind = principalKindLabel(identity);
  const owned = use(OwnerCountsContext)?.get(identity.principalId);
  return (
    <HoverCard>
      <HoverCardTrigger
        render={<span className="relative inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" tabIndex={0} />}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="flex flex-col gap-2" side="bottom">
        <div className="flex items-center gap-2">
          <OwnerAvatar identity={identity} size="default" />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{principalLabel(identity, viewerPrincipalId)}</span>
            {kind === null ? null : <span className="text-xs text-muted-foreground">{kind}</span>}
          </div>
        </div>
        {owned === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            Owns {owned} artifact{owned === 1 ? "" : "s"} in this project
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
