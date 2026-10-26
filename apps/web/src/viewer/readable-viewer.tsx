import {useEffect, useRef, useState} from "react";
import {IconLayoutNavbarExpand} from "@tabler/icons-react";

import {Button} from "@/components/ui/button";
import {Toaster} from "@/components/ui/sonner";

import {ReadableBar} from "./readable-bar.js";
import {useReadableArtifact} from "./use-readable-artifact.js";

/**
 * The flags the server's content policy grants the page, so the frame never
 * grants more even if a response arrived without that policy.
 */
const frameSandbox =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation";
const hiddenBarKey = "artifact-server-viewer-bar";

/** This URL with `raw=1` set, which the server answers with the page itself. */
function rawPageUrl(location: Location): string {
  const query = new URLSearchParams(location.search);
  query.set("raw", "1");
  return `${location.pathname}?${query}${location.hash}`;
}

// Storage throws when site data is blocked; the bar then shows on every load.
function readBarHidden(): boolean {
  try {
    return window.localStorage.getItem(hiddenBarKey) === "hidden";
  } catch {
    return false;
  }
}

function writeBarHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(hiddenBarKey, "hidden");
    else window.localStorage.removeItem(hiddenBarKey);
  } catch {
    // The choice holds for this page; it just will not be remembered.
  }
}

/**
 * A readable artifact URL opened in a tab: the bar, then the page in a
 * sandboxed frame at the same path, so its relative links, assets, and
 * anchors resolve exactly as they do without the bar.
 */
export function ReadableViewer() {
  const [rawUrl] = useState(() => rawPageUrl(window.location));
  const artifact = useReadableArtifact(window.location.pathname);
  const [barHidden, setBarHidden] = useState(readBarHidden);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (artifact.name !== null) document.title = artifact.name;
  }, [artifact.name]);

  const changeBarHidden = (hidden: boolean): void => {
    setBarHidden(hidden);
    writeBarHidden(hidden);
  };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {barHidden ? null : (
        <ReadableBar
          artifact={artifact}
          onFullScreen={() => void frame.current?.requestFullscreen()}
          onHide={() => changeBarHidden(true)}
          rawUrl={rawUrl}
        />
      )}
      <main className="relative min-h-0 flex-1">
        <iframe
          allow="fullscreen; clipboard-write"
          className="absolute inset-0 size-full border-0 bg-white [color-scheme:light]"
          ref={frame}
          sandbox={frameSandbox}
          src={rawUrl}
          title={artifact.name ?? "Artifact"}
        />
        {barHidden ? (
          <Button
            aria-label="Show bar"
            className="absolute top-2 right-2 opacity-60 shadow-sm hover:opacity-100 focus-visible:opacity-100"
            onClick={() => changeBarHidden(false)}
            size="icon-sm"
            variant="outline"
          >
            <IconLayoutNavbarExpand />
          </Button>
        ) : null}
      </main>
      <Toaster />
    </div>
  );
}
