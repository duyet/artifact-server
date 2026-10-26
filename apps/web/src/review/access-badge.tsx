import {IconEyeOff, IconLock, IconWorld, type Icon} from "@tabler/icons-react";

import type {AccessSetting} from "@/api/client";
import {Badge} from "@/components/ui/badge";
import type {Visibility} from "@/lib/visibility";

/** How each visibility reads wherever the viewer names it. */
export const visibilityPresentation = {
  private: {icon: IconLock, label: "Private", variant: "outline"},
  public: {icon: IconWorld, label: "Public", variant: "secondary"},
  unlisted: {icon: IconEyeOff, label: "Unlisted", variant: "secondary"},
} as const satisfies Record<
  Visibility,
  {readonly icon: Icon; readonly label: string; readonly variant: "outline" | "secondary"}
>;

/** Whether an artifact is reachable by anyone with its public link. */
export function AccessBadge({access}: {readonly access: AccessSetting}) {
  return <VisibilityBadge visibility={access === "public_link" ? "public" : "private"} />;
}

/** Who can find and open an artifact, as a labelled badge. */
export function VisibilityBadge({visibility}: {readonly visibility: Visibility}) {
  const {icon: VisibilityIcon, label, variant} = visibilityPresentation[visibility];
  return (
    <Badge variant={variant}>
      <VisibilityIcon data-icon="inline-start" />
      {label}
    </Badge>
  );
}
