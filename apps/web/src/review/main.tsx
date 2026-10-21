import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installDraftGuard } from "@/components/comments/comment-drafts";
import { applyStoredTheme } from "@/lib/theme";

import { ReviewApp } from "./review-app.tsx";
import "../index.css";
import "./review.css";

// Lives for the whole session, above every route: the leave prompt and the
// logout purge must not depend on which screen is mounted.
installDraftGuard();

applyStoredTheme();

const rootElement = document.querySelector("#review-root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <ReviewApp />
  </StrictMode>,
);
