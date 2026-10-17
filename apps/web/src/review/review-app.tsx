import {useCallback, useEffect, useRef, useState} from "react";

import {setDraftPrincipal} from "@/components/comments/comment-drafts";
import {api, ApiError, type AccessContext, type Project, type Session} from "@/api/client";
import {ApiKeySignIn} from "./api-key-sign-in.tsx";
import {ArtifactReview, type ReviewTheme} from "./artifact-review.tsx";
import {ReviewGate} from "./review-primitives.tsx";
import {isSettingsPath} from "./review-routes.ts";
import {ReviewSettings} from "./review-settings.tsx";

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
  const bootstrapInFlightRef = useRef(false);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [sessionState, setSessionState] = useState<
    "loading" | "ready" | "unauthenticated"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  const [theme, setTheme] = useState<ReviewTheme>(readInitialTheme);

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

  useEffect(() => {
    document.documentElement.dataset["reviewTheme"] = theme;
    document.documentElement.classList.toggle("dark", theme === "moon");
    window.localStorage.setItem("artifact-review-theme", theme);
  }, [theme]);

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
          <a className="as-button as-button--primary" href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in
          </a>
        )}
        description="This installation requires an authenticated browser session."
        title="Sign in required"
      />
    );
  }
  if (error !== null) {
    return (
      <ReviewGate
        action={<button className="as-button" onClick={() => void bootstrap()} type="button">Try again</button>}
        description={error.message}
        title="Artifact Server unavailable"
      />
    );
  }
  if (session === null) return null;

  if (isSettingsPath(window.location.pathname)) {
    return (
      <ReviewSettings
        onProjectsChanged={loadProjects}
        onThemeChange={() => setTheme((current) => current === "moon" ? "dawn" : "moon")}
        projects={projects}
        session={session}
        theme={theme}
      />
    );
  }

  return (
    <ArtifactReview
      onCreateProject={createProject}
      onThemeChange={() => setTheme((current) => current === "moon" ? "dawn" : "moon")}
      projects={projects}
      session={session}
      theme={theme}
    />
  );
}

function readInitialTheme(): ReviewTheme {
  return window.localStorage.getItem("artifact-review-theme") === "dawn"
    ? "dawn"
    : "moon";
}

