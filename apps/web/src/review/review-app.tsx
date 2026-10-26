import {useCallback, useEffect, useRef, useState} from "react";

import {setDraftPrincipal} from "@/components/comments/comment-drafts";
import {api, ApiError, type AccessContext, type Project, type Session} from "@/api/client";
import {ApiKeySignIn} from "./api-key-sign-in.tsx";
import {Button, ButtonLink} from "@/components/ui/button";
import {Separator} from "@/components/ui/separator";
import {useTheme} from "@/hooks/use-theme";
import {ReviewGate} from "./review-primitives.tsx";
import {ReviewShell} from "./review-shell.tsx";

const ssoFailureMessages = {
  failed: "Single sign-on did not sign you in. Try again, or use an API key.",
  unavailable: "Single sign-on is unavailable right now. Try again later, or use an API key.",
} as const;

/** The outcome the OIDC callback left in the address, if it names one. */
function readSsoFailure(): keyof typeof ssoFailureMessages | null {
  const outcome = new URLSearchParams(window.location.search).get("sso");
  return outcome === "failed" || outcome === "unavailable" ? outcome : null;
}

/** The current Review address without the OIDC outcome. */
function reviewReturnPath(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("sso");
  return `${url.pathname}${url.search}`;
}

/** Start the artifact-first Artifact Server review application. */
export function ReviewApp() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    setDraftPrincipal(session?.principal.id ?? null);
  }, [session]);
  const accessContextRef = useRef<AccessContext | null>(null);
  const [loginKind, setLoginKind] = useState<
    AccessContext["login"]["kind"] | null
  >(null);
  const [oidcSignIn, setOidcSignIn] = useState(false);
  const [ssoFailure] = useState(readSsoFailure);
  useEffect(() => {
    // Drop the outcome from the address so a reload does not show it again.
    if (ssoFailure !== null) window.history.replaceState(window.history.state, "", reviewReturnPath());
  }, [ssoFailure]);
  const bootstrapInFlightRef = useRef(false);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [sessionState, setSessionState] = useState<
    "loading" | "ready" | "unauthenticated"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  const theme = useTheme();

  const bootstrap = useCallback(async (): Promise<void> => {
    if (bootstrapInFlightRef.current) return;
    bootstrapInFlightRef.current = true;
    setSessionState("loading");
    setError(null);
    try {
      const [loadedAccessContext, initialSession] = await Promise.all([
        api.accessContext(),
        api.session().then(
          (value) => ({kind: "authenticated" as const, value}),
          (cause: unknown) => ({cause, kind: "failed" as const}),
        ),
      ]);
      accessContextRef.current = loadedAccessContext;
      setLoginKind(loadedAccessContext.login.kind);
      setOidcSignIn(
        loadedAccessContext.accessMode === "private_team" && loadedAccessContext.login.oidc,
      );
      let loadedSession: Session;
      if (initialSession.kind === "authenticated") {
        loadedSession = initialSession.value;
      } else if (
        loadedAccessContext.accessMode === "local_owner"
        && initialSession.cause instanceof ApiError
        && initialSession.cause.status === 401
      ) {
        await api.localOwnerSession();
        loadedSession = await api.session();
      } else {
        throw initialSession.cause;
      }
      const loadedProjects = await api.projects();
      setSession(loadedSession);
      setProjects(loadedProjects);
      setSessionState("ready");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
        setSessionState("unauthenticated");
      } else {
        setError(
          caught instanceof Error
            ? caught
            : new Error("Artifact Server could not start."),
        );
        setSessionState("ready");
      }
    } finally {
      bootstrapInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    const expire = (): void => {
      if (accessContextRef.current?.accessMode === "local_owner") {
        void bootstrap();
        return;
      }
      setSession(null);
      setSessionState("unauthenticated");
    };
    window.addEventListener("artifact-session-expired", expire);
    return () => window.removeEventListener("artifact-session-expired", expire);
  }, [bootstrap]);

  const createProject = useCallback(async (name: string): Promise<Project> => {
    const created = await api.createProject(name);
    setProjects((current) => [
      ...current.filter((project) => project.id !== created.id),
      created,
    ]);
    return created;
  }, []);
  const loadProjects = useCallback(async (): Promise<readonly Project[]> => {
    const loaded = await api.projects();
    setProjects(loaded);
    return loaded;
  }, []);

  if (sessionState === "loading") {
    return <ReviewGate description="Opening the local artifact catalog." title="Loading Artifact Server" />;
  }
  if (sessionState === "unauthenticated" && loginKind === "none" && oidcSignIn) {
    return (
      <ReviewGate
        action={(
          <div className="grid gap-6">
            {ssoFailure === null ? null : (
              <div className="text-sm text-destructive" role="alert">
                {ssoFailureMessages[ssoFailure]}
              </div>
            )}
            <ButtonLink
              className="w-full"
              href={`/auth/oidc/start?returnTo=${encodeURIComponent(reviewReturnPath())}`}
            >
              Sign in with SSO
            </ButtonLink>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              <span className="whitespace-nowrap">or use an API key</span>
              <Separator className="flex-1" />
            </div>
            <ApiKeySignIn onSignedIn={() => void bootstrap()} />
          </div>
        )}
        description="Sign in with your organization's single sign-on to review artifacts in this browser."
        title="Sign in"
      />
    );
  }
  if (sessionState === "unauthenticated" && loginKind === "none") {
    return (
      <ReviewGate
        action={<ApiKeySignIn onSignedIn={() => void bootstrap()} />}
        description="Sign in with an Artifact Server API key to review artifacts in this browser."
        title="Sign in with an API key"
      />
    );
  }
  if (sessionState === "unauthenticated") {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return (
      <ReviewGate
        action={(
          <ButtonLink className="w-full" href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in
          </ButtonLink>
        )}
        description="This installation requires an authenticated browser session."
        title="Sign in required"
      />
    );
  }
  if (error !== null) {
    return (
      <ReviewGate
        action={<Button onClick={() => void bootstrap()} variant="outline">Try again</Button>}
        description={error.message}
        title="Artifact Server unavailable"
      />
    );
  }
  if (session === null) return null;

  return (
    <ReviewShell
      onCreateProject={createProject}
      onProjectsChanged={loadProjects}
      onThemeChange={theme.setPreference}
      projects={projects}
      session={session}
      theme={theme.resolved}
      themePreference={theme.preference}
    />
  );
}
