import {StrictMode, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";

import {HomePage} from "./home-app.js";
import {readPublicCatalog, type PublicCatalog} from "./home-client.js";
import "../index.css";

const initialTheme = window.localStorage.getItem("artifact-review-theme") === "dawn"
  ? "dawn"
  : "moon";
document.documentElement.classList.toggle("dark", initialTheme === "moon");

function HomeShell() {
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

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
  }, []);

  if (failure !== null) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="font-heading text-xl font-semibold">Catalog unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{failure}</p>
      </main>
    );
  }
  if (catalog === null) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-sm text-muted-foreground">
        Loading the public catalog…
      </main>
    );
  }
  return <HomePage catalog={catalog} />;
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