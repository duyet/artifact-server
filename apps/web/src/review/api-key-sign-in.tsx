import {type FormEvent, useState} from "react";

import {api} from "@/api/client";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {useSignInAttempt} from "./use-sign-in-attempt.ts";

/** Browser sign-in for a server whose login kind is none. */
export function ApiKeySignIn({onSignedIn}: {readonly onSignedIn: () => void}) {
  const [apiKey, setApiKey] = useState("");
  const {attempt, state} = useSignInAttempt("That API key was not accepted.", onSignedIn);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (await attempt(() => api.signInWithApiKey(apiKey))) setApiKey("");
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
