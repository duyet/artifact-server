import {useEffect, useState} from "react";

import {api, type Branding} from "@/api/client";
import {ArtifactMark} from "../artifact-mark.tsx";

let brandingRequest: Promise<Branding> | null = null;

/** The installation's branding, read once per page load. */
function loadBranding(): Promise<Branding> {
  // The logo is decoration, so a failed read shows the product mark.
  brandingRequest ??= api.branding().catch(() => ({logo: null}));
  return brandingRequest;
}

/**
 * The configured logo, linked when the operator set a link, or the product
 * mark when no logo is configured. Nothing renders until the branding loads,
 * so the mark never flashes before a configured logo.
 */
export function ViewerLogo() {
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const loaded = await loadBranding();
      if (current) setBranding(loaded);
    })();
    return () => {
      current = false;
    };
  }, []);

  if (branding === null) return null;
  const logo = branding.logo;
  if (logo === null) return <ArtifactMark className="size-5 shrink-0" />;
  const image = (
    <img alt={logo.alt} className="h-5 w-auto max-w-[120px] shrink-0 object-contain" src={logo.src} />
  );
  return logo.href === null ? image : (
    <a
      className="flex shrink-0 items-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      href={logo.href}
    >
      {image}
    </a>
  );
}
