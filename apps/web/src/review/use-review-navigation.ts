import {useCallback, useEffect, useState} from "react";

/** The part of the browser location the review application routes on. */
export interface ReviewUrl {
  readonly pathname: string;
  readonly search: string;
}

export type NavigationMode = "push" | "replace";

export interface ReviewNavigation {
  readonly navigate: (href: string, mode?: NavigationMode) => void;
  readonly url: ReviewUrl;
}

function currentUrl(): ReviewUrl {
  return {pathname: window.location.pathname, search: window.location.search};
}

/**
 * Keep the review application's routing state equal to the browser URL.
 *
 * The URL is the only source of truth: every page derives its project,
 * artifact, version, file, and view from it, so Back, Forward, reload, and a
 * copied link all land on the same screen.
 */
export function useReviewNavigation(): ReviewNavigation {
  const [url, setUrl] = useState<ReviewUrl>(currentUrl);

  useEffect(() => {
    const restore = (): void => setUrl(currentUrl());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const navigate = useCallback((href: string, mode: NavigationMode = "push"): void => {
    const target = new URL(href, window.location.origin);
    const next = `${target.pathname}${target.search}`;
    if (next === `${window.location.pathname}${window.location.search}`) return;
    if (mode === "push") window.history.pushState(null, "", next);
    else window.history.replaceState(null, "", next);
    setUrl(currentUrl());
  }, []);

  return {navigate, url};
}

/**
 * Turn plain clicks on same-application links into client-side navigation.
 * Listening on the document covers menus and dialogs rendered in portals.
 * Links stay real anchors, so opening one in a new tab, copying it, or a
 * modified click keeps the browser's own behavior.
 */
export function useSameAppLinks(navigate: ReviewNavigation["navigate"]): void {
  useEffect(() => {
    const intercept = (event: MouseEvent): void => {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target !== "" && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download") || anchor.origin !== window.location.origin) return;
      if (anchor.pathname !== "/review" && !anchor.pathname.startsWith("/review/")) return;
      event.preventDefault();
      navigate(`${anchor.pathname}${anchor.search}`);
    };
    document.addEventListener("click", intercept);
    return () => document.removeEventListener("click", intercept);
  }, [navigate]);
}
