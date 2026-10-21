import {useCallback, useEffect, useState, useSyncExternalStore} from "react";

import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  subscribeSystemTheme,
  systemPrefersDark,
  writeThemePreference,
  type ThemePreference,
} from "@/lib/theme";

export function useTheme() {
  const [preference, setStoredPreference] = useState(readThemePreference);
  const systemDark = useSyncExternalStore(subscribeSystemTheme, systemPrefersDark);
  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    writeThemePreference(next);
  }, []);

  return {preference, resolved, setPreference};
}
