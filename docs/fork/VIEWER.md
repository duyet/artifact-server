# Viewer bar

Issue 37 adds a thin bar above an open artifact in Review: the installation's logo, the artifact's name, an info button, and a menu of actions. This note says where the bar lives, what the info button reads, and who may change an artifact's visibility from it.

```
[sidebar] | [logo] Title (i)  [‹ v2 of 3 ›]  ........  [annotate] [full screen] [inspector] [Share] [⋯]
```

## Where the bar lives

The bar is the existing top bar of Review's artifact viewer, `apps/web/src/review/viewer/viewer-top-bar.tsx`, reshaped. It is 40px tall and sits in the viewer's flex column above the preview, so the preview starts below it and nothing overlaps.

Review shows artifact HTML in an opaque-origin `srcdoc` frame (CMT-014). The bar is application DOM outside that frame, so artifact code cannot read it, style it, or click it, and the bar never enters artifact content.

The readable folder and path URLs serve the artifact document itself at the top level, under a CSP sandbox (FRK-002). A bar there would need markup injected into the artifact's HTML, which the sandbox design forbids, or a new framing route. Neither is in scope, so those URLs keep no bar.

The **⋯** menu holds the actions the old chevron menu held, plus the open-raw and download buttons that used to sit beside it:

1. Copy link, Versions, Open raw, Download.
2. Rename, Edit file, Duplicate, Share.
3. Delete, when the reader may delete.

Below 640px the annotate, full screen, and inspector buttons hide, and **⋯** gains **Annotate**, **Full screen**, and **Open inspector** in their place. The title truncates and the page never scrolls sideways.

## Visibility

Visibility is derived from two stored fields and has no storage of its own.

| Visibility | `accessSetting` | `unlisted` tag | Opens by link | In the public tree |
| --- | --- | --- | --- | --- |
| Public | `public_link` | absent | yes | yes |
| Unlisted | `public_link` | present | yes | no |
| Private | `account_required` | ignored | no | no |

`artifactVisibility` in `src/application/artifact-tags.ts` derives it on the server, and `visibilityOf` in `apps/web/src/lib/visibility.ts` derives it in the browser.

The info popover changes visibility with the existing `PATCH /api/v1/artifacts/:id/access` and `PATCH /api/v1/artifacts/:id/tags` routes. No new write route exists. `visibilitySteps` returns only the writes whose value differs, in an order that never passes through a state more exposed than both the start and the target:

- To private, only the access write runs. Private never edits tags.
- To public or unlisted, the tag write runs first and the access write second. Going from private to unlisted therefore adds the tag while the artifact is still private, then opens it.

Each write carries its own idempotency key and the current version ID. If the second write fails, the first one stays, and the popover shows the error with the state that was reached.

## Who can change visibility

`canManageArtifact` in `src/application/authorization.ts` is the one rule. A principal may change an artifact's visibility when it belongs to the artifact's installation and any of these holds:

- It owns the artifact, either as the owner's own session or as a key that carries the owner's principal ID and holds `artifact:create`. A member's own key carries the member's principal ID (`src/application/installation-access.ts`), but a key scoped to `artifact:read`, `comment:write`, or `content-session:issue` does not own what the member published, so it cannot make the member's private artifacts public. `requireVersionPublication` draws the same line.
- It is a direct human administrator.
- It holds `artifact:manage:any`.

`AuthorizationService.requireArtifactOwnership` applies the rule and fails with `AUTHORIZATION_DENIED`. These writes use it:

- `PATCH /access` and the MCP tool `artifact_set_visibility`, always.
- `PATCH /tags` and the MCP tool `artifact_set_tags`, when the request adds or removes `unlisted`. The tag is compared after normalization, so `Unlisted` counts.

Any other tag edit keeps the management rule, under which every direct human member may edit tags. A tag replacement that changes nothing passes under either rule, so a retried request does not fail where its first call passed.

Before this change, any direct human member could change any artifact's access, and a member key could not change its own.

## Info endpoint

`GET /api/v1/artifacts/:artifactId/info?projectId=<id>` needs the same credential and artifact read access as `GET /api/v1/artifacts/:artifactId`. `readArtifactInfo` in `src/application/artifact-info.ts` composes `ArtifactManagementService.getArtifact`, `ProjectAnalyticsService.readArtifactActivity`, `canManageArtifact`, and `artifactVisibility`.

```json
{
  "artifactId": "art_...",
  "name": "Quarterly report",
  "owner": {"displayName": "Example Owner"},
  "version": {"id": "ver_...", "number": 4},
  "visibility": "public",
  "updatedAt": "2026-10-26T10:00:00.000Z",
  "views": {"total": 12, "last30Days": 9, "daily": [{"day": "2026-10-25", "views": 3}]},
  "windowDays": 30,
  "canManage": true
}
```

- `owner.displayName` is the name stored when the artifact was created, or null for an artifact created before names were recorded. The response never carries the owner's principal ID or an email.
- `version` and `updatedAt` describe the current version. `updatedAt` is that version's creation time, the same value the home page tree calls `updatedAt`.
- `views.daily` is the sparse series of `readArtifactActivity`, ascending, with only the days that have views. The popover fills the missing days with zero to draw 30 bars that end today.
- `canManage` is `canManageArtifact` for the reader. The popover offers the visibility control only when it is true, and Share's access screen turns read-only when it is false. The info read also reads views, so while it loads or after it fails Share keeps its access controls and the server decides; a refused change shows that only the owner or an administrator can make it.

The viewer reads the info when the artifact opens, and again whenever the artifact's access, tags, name, or current version change, whether the change came from the popover, from Share, a rename, or a new version. The visibility control reads the artifact record the viewer already holds, which each write updates at once, so it never shows the old value while the info reloads.

## Viewer logo

The bar shows the installation's logo when an operator configures one, and the product mark otherwise. Three environment variables set it, for both compact and external-storage servers:

| Variable | Meaning |
| --- | --- |
| `ARTIFACT_SERVER_LOGO` | An `https://` URL without credentials, or an absolute path to a `.svg`, `.png`, `.webp`, `.jpg`, or `.jpeg` file of at most 256 KiB. |
| `ARTIFACT_SERVER_LOGO_ALT` | The image's alternative text, 1 to 100 characters. Required when `ARTIFACT_SERVER_LOGO` is set. |
| `ARTIFACT_SERVER_LOGO_LINK` | Optional. An `https://` URL, or a path that starts with exactly one `/`. Without it, the logo is not a link. |

`src/lifecycle/runtime-configuration.ts` parses them at startup and reads a logo file once into memory. Every refusal stops startup with `RuntimeConfigurationError`:

- `invalid_value` for an `http://` or credentialed URL, a relative path, an unsupported extension, a file over 256 KiB, an alt over 100 characters, or a link such as `//host`, `/\host`, or `javascript:`.
- `path_unavailable` for a file that does not exist or is not a regular file.
- `missing_value` for a logo without alt text.
- `incomplete_configuration` for an alt or a link without a logo.

`config check` reports `logo` as `{source, location, alt, link}`, where `source` is `url` or `file` and `location` is the URL or the path, or `null` when no logo is set.

Two anonymous routes under `/api/v1/public/` serve it, so no reserved path root changes:

- `GET /api/v1/public/branding` answers `{"logo": {"src", "alt", "href"}}`, or `{"logo": null}`, with `Cache-Control: no-cache`. `src` is the configured URL, or `/api/v1/public/logo` for a file. Review fetches it once per page load.
- `GET` and `HEAD /api/v1/public/logo` serve a logo file with its extension's media type, `X-Content-Type-Options: nosniff`, an ETag that answers 304, and `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. Someone who opens an SVG logo at this URL gets a document on the application origin, and the sandbox stops its scripts. Without a logo file, the route answers 404 `NOT_FOUND`.

A URL logo loads from another origin, so the application pages' policy adds that URL's exact origin to `img-src`, as in `img-src 'self' data: https://cdn.example.com`. No other directive changes, and the content sandbox and the review frame's policy stay as they were.
