import {type FormEvent, useState} from "react";

import {api} from "@/api/client";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {useSignInAttempt} from "./use-sign-in-attempt.ts";

/** Directory (LDAP) username and password sign-in, shown when the server enables it. */
export function DirectorySignIn({onSignedIn}: {readonly onSignedIn: () => void}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const {attempt, state} = useSignInAttempt(
    "That username or password was not accepted.",
    onSignedIn,
  );

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    await attempt(() => api.signInWithDirectory(username, password));
    setPassword("");
  };

  return (
    <form className="grid gap-3 text-left" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-2">
        <Label htmlFor="directory-sign-in-username">Username</Label>
        <Input
          autoCapitalize="none"
          autoComplete="username"
          id="directory-sign-in-username"
          onChange={(event) => setUsername(event.currentTarget.value)}
          spellCheck={false}
          value={username}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="directory-sign-in-password">Password</Label>
        <Input
          aria-describedby={state.kind === "failed" ? "directory-sign-in-error" : undefined}
          aria-invalid={state.kind === "failed"}
          autoComplete="current-password"
          id="directory-sign-in-password"
          onChange={(event) => setPassword(event.currentTarget.value)}
          type="password"
          value={password}
        />
      </div>
      {state.kind === "failed" ? (
        <div className="text-sm text-destructive" id="directory-sign-in-error" role="alert">
          {state.message}
        </div>
      ) : null}
      <Button
        disabled={state.kind === "pending" || username.trim() === "" || password === ""}
        type="submit"
      >
        {state.kind === "pending" ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}
