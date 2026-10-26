import {useEffect, useState} from "react";

import {readSignInContext, type SignInContext} from "./sign-in-context.js";

/**
 * The server's sign-in context, or null until it answers. A failed read stays
 * null, so Sign in keeps Review's gate and Help stays hidden.
 */
export function useSignInContext(): SignInContext | null {
  const [context, setContext] = useState<SignInContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await readSignInContext();
        if (!cancelled) setContext(loaded);
      } catch {
        // Null already means Review's gate and no Help item.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);
  return context;
}
