import {type AccessSetting, accessSettings} from "./model.js";
import type {OidcSignIn} from "./oidc-sign-in.js";

/** Browser access modes selected by an Artifact Server deployment entrypoint. */
export const browserAccessModes = {
  localOwner: "local_owner",
  privateTeam: "private_team",
} as const;

/** Browser sign-in mechanisms disclosed to the management application. */
export const browserLoginKinds = {
  localOwner: "local_owner",
  none: "none",
} as const;

/**
 * Browser authentication policy fixed by the deployment composition root.
 *
 * The discriminated union prevents a team deployment from enabling
 * local-owner access accidentally.
 */
export type BrowserAccess =
  | {
    readonly loginKind: typeof browserLoginKinds.localOwner;
    readonly mode: typeof browserAccessModes.localOwner;
  }
  | {
    readonly loginKind: typeof browserLoginKinds.none;
    readonly mode: typeof browserAccessModes.privateTeam;
    /** OpenID Connect sign-in next to API-key sign-in, or null. */
    readonly oidc: OidcSignIn | null;
  };

/** The browser access policy for a single-developer, loopback-only process. */
export const localOwnerBrowserAccess: BrowserAccess = {
  loginKind: browserLoginKinds.localOwner,
  mode: browserAccessModes.localOwner,
};

/** Create the browser access policy for a remotely deployed private team. */
export function privateTeamBrowserAccess(
  loginKind: typeof browserLoginKinds.none,
  oidc: OidcSignIn | null = null,
): Extract<BrowserAccess, {readonly mode: "private_team"}> {
  return {loginKind, mode: browserAccessModes.privateTeam, oidc};
}

/** The OIDC sign-in a browser may use, or null when it has none. */
export function oidcSignIn(browserAccess: BrowserAccess): OidcSignIn | null {
  return browserAccess.mode === browserAccessModes.privateTeam ? browserAccess.oidc : null;
}

/** The access setting a new artifact gets when its publisher names none. */
export function defaultAccessSetting(browserAccess: BrowserAccess): AccessSetting {
  return browserAccess.loginKind === browserLoginKinds.none
    ? accessSettings.publicLink
    : accessSettings.accountRequired;
}
