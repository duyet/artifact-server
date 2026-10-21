import {afterEach, describe, expect, test, vi} from "vitest";

import {
  applyStoredTheme,
  readThemePreference,
  writeThemePreference,
} from "../../apps/web/src/lib/theme.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function blocked(): never {
  throw new DOMException("Access is denied", "SecurityError");
}

function blockedStorage(): Pick<Storage, "getItem" | "setItem"> {
  return {getItem: blocked, setItem: blocked};
}

function browser({
  storage = memoryStorage(),
  systemDark = false,
}: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  systemDark?: boolean;
} = {}) {
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (name: string, force: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
  };
  vi.stubGlobal("window", {
    localStorage: storage,
    matchMedia: () => ({matches: systemDark}),
  });
  vi.stubGlobal("document", {documentElement: root});
  return classes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  test("a reader who never chose follows the system", () => {
    browser();
    expect(readThemePreference()).toBe("system");
  });

  test("a chosen theme is remembered across page loads", () => {
    const storage = memoryStorage();
    browser({storage});
    writeThemePreference("light");
    browser({storage});
    expect(readThemePreference()).toBe("light");
  });

  test("an unknown stored value falls back to the system", () => {
    const storage = memoryStorage();
    storage.setItem("artifact-server-theme", "moon");
    browser({storage});
    expect(readThemePreference()).toBe("system");
  });

  test("blocked storage neither throws nor breaks the page", () => {
    browser({storage: blockedStorage()});
    expect(() => writeThemePreference("dark")).not.toThrow();
    expect(readThemePreference()).toBe("system");
  });
});

describe("applying the stored theme", () => {
  test("system follows the operating system setting", () => {
    const darkSystem = browser({systemDark: true});
    applyStoredTheme();
    expect([...darkSystem]).toEqual(["dark"]);

    const lightSystem = browser({systemDark: false});
    applyStoredTheme();
    expect([...lightSystem]).toEqual(["light"]);
  });

  test("an explicit choice wins over the operating system", () => {
    const storage = memoryStorage();
    browser({storage});
    writeThemePreference("light");

    const classes = browser({storage, systemDark: true});
    applyStoredTheme();
    expect([...classes]).toEqual(["light"]);
  });
});
