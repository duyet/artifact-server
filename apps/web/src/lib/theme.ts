import {z} from "zod";

export const themePreferences = ["light", "dark", "system"] as const;
/** What the reader chose. `system` follows the operating system setting. */
export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = "light" | "dark";

const storedPreferenceSchema = z.enum(themePreferences).catch("system");

/** Shared by the home page and Console, so a choice in one carries to the other. */
const storageKey = "artifact-server-theme";
const systemDarkQuery = "(prefers-color-scheme: dark)";

// Storage throws when site data is blocked; the page still renders on `system`.
export function readThemePreference(): ThemePreference {
  try {
    return storedPreferenceSchema.parse(window.localStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(storageKey, preference);
  } catch {
    // The choice still applies for this page; it just will not be remembered.
  }
}

export function systemPrefersDark(): boolean {
  return window.matchMedia(systemDarkQuery).matches;
}

export function subscribeSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(systemDarkQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** The class on <html> is the one switch every token and `dark:` utility reads. */
export function applyTheme(theme: ResolvedTheme, root: Element = document.documentElement): void {
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

export function applyStoredTheme(): void {
  applyTheme(resolveTheme(readThemePreference(), systemPrefersDark()));
}
