import {StrictMode} from "react";
import {createRoot} from "react-dom/client";

import {applyStoredTheme, subscribeSystemTheme} from "@/lib/theme";

import {ReadableViewer} from "./readable-viewer.js";
import "../index.css";

applyStoredTheme();
subscribeSystemTheme(applyStoredTheme);

const rootElement = document.querySelector("#viewer-root");
if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}
createRoot(rootElement).render(
  <StrictMode>
    <ReadableViewer />
  </StrictMode>,
);
