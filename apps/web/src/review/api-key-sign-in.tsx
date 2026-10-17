import {type FormEvent, useState} from "react";

import {api} from "@/api/client";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";

type SignInState =
  | {readonly kind: "idle"}
  | {readonly kind: "pending"}
  | {readonly kind: "failed"; readonly message: string};

/** Browser sign-in for a server whose login kind is none. */
export function ApiKeySignIn({onSignedIn}: {readonly onSignedIn: () => void}) {
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<SignInState>({kind: "idle"});

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setState({kind: "pending"});
    try {
      const result = await api.signInWithApiKey(apiKey);
      switch (result.kind) {
        case "signed_in":
          setApiKey("");
          setState({kind: "idle"});
          onSignedIn();
          return;
        case "rejected":
          setState({kind: "failed", message: "That API key was not accepted."});
          return;
        case "rate_limited":
          setState({
            kind: "failed",
            message: `Too many failed attempts. Try again in ${result.retryAfterSeconds} s.`,
          });
          return;
        default:
          result satisfies never;
      }
    } catch (caught) {
      setState({
        kind: "failed",
        message: caught instanceof Error ? caught.message : "Sign-in failed.",
      });
    }
  };

  return (
    <form className="grid gap-3 text-left" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-2">
        <Label htmlFor="api-key-sign-in">API key</Label>
        <Input
          aria-describedby={state.kind === "failed" ? "api-key-sign-in-error" : undefined}
          aria-invalid={state.kind === "failed"}
          autoComplete="off"
          id="api-key-sign-in"
          onChange={(event) => setApiKey(event.currentTarget.value)}
          spellCheck={false}
          type="password"
          value={apiKey}
        />
      </div>
      {state.kind === "failed" ? (
        <div className="text-sm text-destructive" id="api-key-sign-in-error" role="alert">
          {state.message}
        </div>
      ) : null}
      <Button disabled={state.kind === "pending" || apiKey.trim() === ""} type="submit">
        {state.kind === "pending" ? "Signing in" : "Sign in"}
      </Button>
      <small>Anyone can still open shared artifact links without signing in.</small>
    </form>
  );
}
