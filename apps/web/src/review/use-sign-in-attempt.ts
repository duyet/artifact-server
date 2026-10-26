import {useState} from "react";

import type {SignInOutcome} from "@/api/client";

export type SignInState =
  | {readonly kind: "idle"}
  | {readonly kind: "pending"}
  | {readonly kind: "failed"; readonly message: string};

/** One sign-in form's request state, shared by the API-key and directory forms. */
export function useSignInAttempt(rejectedMessage: string, onSignedIn: () => void) {
  const [state, setState] = useState<SignInState>({kind: "idle"});

  const attempt = async (signIn: () => Promise<SignInOutcome>): Promise<boolean> => {
    setState({kind: "pending"});
    try {
      const result = await signIn();
      switch (result.kind) {
        case "signed_in":
          setState({kind: "idle"});
          onSignedIn();
          return true;
        case "rejected":
          setState({kind: "failed", message: rejectedMessage});
          return false;
        case "rate_limited":
          setState({
            kind: "failed",
            message: `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.`,
          });
          return false;
        default:
          result satisfies never;
          return false;
      }
    } catch (caught) {
      setState({
        kind: "failed",
        message: caught instanceof Error ? caught.message : "Sign-in failed.",
      });
      return false;
    }
  };

  return {attempt, state};
}
