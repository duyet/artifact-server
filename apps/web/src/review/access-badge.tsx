import {IconLock, IconWorld} from "@tabler/icons-react";

import type {AccessSetting} from "@/api/client";
import {Badge} from "@/components/ui/badge";

/** Whether an artifact is reachable by anyone with its public link. */
export function AccessBadge({access}: {readonly access: AccessSetting}) {
  return access === "public_link" ? (
    <Badge variant="secondary">
      <IconWorld data-icon="inline-start" />
      Public
    </Badge>
  ) : (
    <Badge variant="outline">
      <IconLock data-icon="inline-start" />
      Private
    </Badge>
  );
}
