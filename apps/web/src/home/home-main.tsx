import {StrictMode, useCallback, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";

import {IconAlertCircle} from "@tabler/icons-react";

import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import {Skeleton} from "@/components/ui/skeleton";
import {applyStoredTheme} from "@/lib/theme";

import {HomePage} from "./home-app.js";
import {readPublicCatalog, type PublicCatalog} from "./home-client.js";
import "../index.css";

applyStoredTheme();

function HomeShell() {
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Bumped after the page changes an artifact, so the tree reads it again.
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await readPublicCatalog();
        if (!cancelled) setCatalog(loaded);
      } catch (cause) {
        if (!cancelled) {
          setFailure(
            cause instanceof Error
              ? cause.message
              : "The public catalog could not be read.",
          );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  if (failure !== null) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-16">
        <h1 className="font-heading text-xl font-semibold">Catalog unavailable</h1>
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertTitle>The public catalog could not be loaded</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (catalog === null) {
    return (
      <main
        aria-busy="true"
        className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10"
      >
        <p className="sr-only" role="status">Loading the public catalog…</p>
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </main>
    );
  }
  return <HomePage catalog={catalog} onChanged={reload} />;
}

const rootElement = document.querySelector("#home-root");
if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}
createRoot(rootElement).render(
  <StrictMode>
    <HomeShell />
  </StrictMode>,
);