import {z} from "zod";

const signInContextSchema = z.object({
  helpUrl: z.union([
    z.url({protocol: /^https$/u}),
    // The server's rule: one leading slash, then no backslash, whitespace, or
    // control code, any of which a browser could read as another host.
    z.string().regex(/^\/(?![/\\])[^\s\\\p{Cc}]*$/u),
  ]),
  login: z.object({oidc: z.boolean().optional()}),
});

/** What an account control needs before anyone signs in. */
export interface SignInContext {
  /** The operator's Help page: an https URL or a path on this origin. */
  readonly helpUrl: string;
  /** Sign in can start SSO, which comes back to the page it left. */
  readonly oidc: boolean;
}

/**
 * The page a sign-in comes back to. An artifact's page travels as its ID
 * only; the server rebuilds the page from the stored artifact.
 */
export type SignInReturn =
  | {readonly kind: "home"}
  | {readonly artifactId: string; readonly kind: "artifact"};

/** Read the sign-in route and Help link without loading the API client. */
export async function readSignInContext(
  fetchImplementation: typeof fetch = fetch,
): Promise<SignInContext> {
  const response = await fetchImplementation("/auth/context", {
    headers: {Accept: "application/json"},
  });
  if (!response.ok) {
    throw new Error(`The sign-in context request returned HTTP ${response.status}.`);
  }
  const context = signInContextSchema.parse(await response.json());
  return {helpUrl: context.helpUrl, oidc: context.login.oidc === true};
}

/**
 * Where Sign in goes: SSO when the server has it, otherwise Review's gate,
 * which offers every sign-in this server has. Until the context answers, the
 * gate too.
 */
export function signInHref(context: SignInContext | null, back: SignInReturn): string {
  if (context?.oidc !== true) return "/review";
  const query = back.kind === "home"
    ? new URLSearchParams({returnTo: "/"})
    : new URLSearchParams({returnArtifact: back.artifactId});
  return `/auth/oidc/start?${query}`;
}
