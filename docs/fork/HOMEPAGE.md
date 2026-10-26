# Home page tree and view analytics

This section is the design for issue 5, the home page at `/`. Citations are against `748e704`. It follows section 11 of `docs/fork/DESIGN.md`, which made artifacts claim a readable path; this document consumes those paths and adds the view counters that the tree shows.

The shape follows `https://html.duyet.net/` and its source `duyet/sharehtml`. That deployment's design note (`DESIGN.md`, "sharehtml Design System — Paper") makes the rules this page copies:

- Structure comes from 1px hairlines, not shadows or color. One bordered box, cells split by vertical hairlines.
- Doc lists are rows separated by hairlines, with muted right-aligned meta.
- Sans for everything, `font-variant-numeric: tabular-nums` for every number, so counts do not jitter as they change.
- Light and dark are the same primitives with different values.

The Artifact Server web app already has that token set (`apps/web/src/theme-tokens.css`: `--border`, `--muted-foreground`, `--chart-1` to `--chart-5`), so the home page uses those tokens and adds no colors of its own. Issue 4 applies the shadcn preset `b3kI32KO0` to the same tokens; this page reads them, so the preset lands on it without an edit.

## 1. Data shape

Views are counts of one thing: a browser asked for an artifact's entry document. They are not events, so they are one table and no event log. The table has exactly the three columns issue 5 names, and nothing else.

```sql
-- SQLite, in the #migrate baseline next to the other artifact-scoped tables
CREATE TABLE IF NOT EXISTS artifact_views (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  day TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (artifact_id, day)
) STRICT;

-- Postgres, migration 0013_artifact_views
CREATE TABLE artifact_views (
  installation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (installation_id, artifact_id, day),
  FOREIGN KEY (installation_id, artifact_id)
    REFERENCES artifacts(installation_id, id)
);
```

Three decisions:

1. **`day` is a `TEXT` UTC calendar day, `YYYY-MM-DD`.** Not a timestamp and not a date type, so SQLite and Postgres agree byte for byte and a row is comparable with `<=` and `>=` as text. Day boundaries are UTC because that is the only zone the server's logs and the artifact `createdAt` values are already normalized to. A local-time zone would need a stored offset and a calendar library for no product gain.
2. **No `installation_id` in SQLite.** `artifacts.id` is `TEXT PRIMARY KEY` there (`src/storage/sqlite-artifact-repository.ts:4778`), so one artifact ID names one artifact in one database. Postgres has the composite key `(installation_id, id)` (`src/storage/postgres-migrations.ts`), so its view rows carry the installation, exactly as `versions`, `actions`, and `comment_threads` do.
3. **No foreign-key cascade and no `ON DELETE`.** Deletion is a one-way tombstone (`src/storage/postgres-artifact-repository.ts:1505`), so the parent row never disappears and the counters never need a cascade. A deleted artifact's rows stay and are simply unreachable, because every reader filters on a live artifact.

The port is new and narrow, in `src/core/ports.ts`, beside the other artifact-scoped repositories:

```ts
/** Durable per-artifact view counters. One row is one artifact on one UTC day. */
export interface ArtifactViewRepository {
  /** Add each coalesced delta to its artifact's row for that day. */
  recordArtifactViews(deltas: readonly ArtifactViewDelta[]): Promise<void>;
  /** Read the daily rows inside one inclusive `[sinceDay, untilDay]` window. */
  readArtifactViewDays(
    command: ReadArtifactViewDays,
  ): Promise<readonly ArtifactViewDay[]>;
  /** Read each requested artifact's all-time total. */
  readArtifactViewTotals(
    artifactIds: readonly string[],
  ): Promise<readonly ArtifactViewTotal[]>;
}
```

`recordArtifactViews` is additive and idempotent per call, not per delta: two drains of the same delta must add twice, because they are two view batches. `readArtifactViewDays` and `readArtifactViewTotals` are separate because the window is bounded by the query and the total is not. Summing the window would silently answer "last 30 days" when the column says "total".

| Backend | Schema change | Write |
| --- | --- | --- |
| SQLite | The table joins the `CREATE TABLE IF NOT EXISTS` baseline in `#migrate` (`src/storage/sqlite-artifact-repository.ts:4769`). `requiredSqliteSchemaVersion` stays 13 (`src/storage/sqlite-schema.ts:9`): the baseline creates every table with `IF NOT EXISTS` on every start, so a new table needs no new version, and bumping it would strand databases that have not been opened since 13. | One `INSERT ... ON CONFLICT(artifact_id, day) DO UPDATE SET count = count + excluded.count` inside one `#transaction` (`BEGIN IMMEDIATE`, `:5752`), so the whole batch takes the single writer lock once. |
| Postgres | Migration `0013_artifact_views`, registered in `Migrator.fromRecord` (`src/storage/postgres-migrations.ts:683`), `requiredPostgresSchemaVersion` becomes 13 (`:687`), and `expectedHistory` gains `{migration_id: 13, name: "artifact_views"}` (`:778`). | One statement per chunk inside one `sql.withTransaction`. `ON CONFLICT (installation_id, artifact_id, day) DO UPDATE` takes a row lock, so two replicas draining at the same moment add rather than overwrite. |
| D1 | One `CREATE TABLE IF NOT EXISTS artifact_views` statement in `deploy/cloudflare/src/d1-migrations.ts`, matching the SQLite shape because D1 is SQLite. `requiredD1SchemaVersion` follows the list length. | Same upsert through the D1 handle. |

D1 is in scope because `deploy/cloudflare/src/worker.ts:219` builds the same `HttpAppDependencies`, and a deployment whose home page silently reported zero views would be worse than one that reports them.

### What is counted

One view is one `GET` that returns an artifact's entry document. Nothing else.

| Request | Counted | Why |
| --- | --- | --- |
| `GET /2026/10/release-checklist/` | yes | The page view. |
| `GET /2026/10/release-checklist/index.html` | yes | The same entry document by name. |
| `GET /2026/10/release-checklist/settings/profile` on an SPA | yes | The client route resolved to the entry document; a browser navigation happened. |
| `GET /2026/10/release-checklist/assets/a.css` | no | An asset, not a page. |
| `HEAD` on any of the above | no | A probe, not a page load. |
| `304 Not Modified` on the entry document | yes | A reload is a view. The browser asked again and was told the page was current. |
| `/v/<token>/…`, a folder `/<slug>-<uuid>/…`, a path `/<path>/…` | yes | All three forms end at `serveVersionContent` (`src/http/create-http-app.ts:3529`), so one call site covers them. |
| A Review lease, `/v/review-<token>/…`, a live source, a bootstrap exchange | no | A lease renders one artifact's version inside another surface. Counting it would charge the operator for previewing their own work and would double the number when the same page is also open at its own URL. |
| A 404 or a 401 at an artifact URL | no | No document was served. |

The call sits in `serveVersionContent` after `authorizeVersionContent` returns and before the response is built:

```ts
if (context.req.method === "GET" &&
    (requestedPath === "" || requestedPath === content.entryPath)) {
  dependencies.artifactViews?.record(content.artifactId);
}
```

`requestedPath` is `""` for `/` and the manifest path otherwise (`src/manifest/create-manifest.ts:73`). `content.entryPath` is the version's declared entry document, which is why `VersionContent` carries it beside `entry`: `entry` is whichever manifest entry the request resolved to, so it equals `entryPath` for the page and differs from it for every asset.

**SPA fallback counts.** A client route such as `/2026/10/release-checklist/settings/profile` on an SPA names no file, but for a browser navigation it answers the entry document, so it is one page view. The gate above is written for exactly that rule: it counts one GET whenever the response carries the entry document (`content.entry.path === content.entryPath`), which covers the path, folder, version-URL, and fallback forms with one comparison and still excludes every asset, every HEAD probe, and every 404. FRK-008-B proves the fallback form: one client-route navigation lands exactly one view, and the same navigation on a static artifact is a plain 404 with no row.

### Written without blocking the response

`record` is synchronous, in-memory, and total. It is a `Map` increment keyed by `` `${artifactId}\u0000${day}` `` and cannot fail, await, or touch a database. The content response never waits for a counter.

The drain is a background loop, built exactly like `src/lifecycle/staging-cleanup.ts`: `runtime.runFork(Effect.repeat(pass, Schedule.spaced(intervalMilliseconds)))` with a closer that interrupts the fiber and then flushes the remainder (`src/lifecycle/staging-cleanup.ts:84`). Two files:

- `src/application/artifact-view-recorder.ts` — the recorder. A value, not an Effect service, because the content path must call it synchronously. It takes its clock as the existing `Clock` port (`src/core/ports.ts:720`), which is already synchronous, so tests can pin the day.
- `src/lifecycle/artifact-view-collection.ts` — the loop and the policy, mirroring `StagingCleanupPolicy`.

The drain writes in chunks of at most 500 rows. SQLite binds 2 parameters per row (the value plus nothing, since `ON CONFLICT` names its own columns), and `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds; 500 rows stay under it on any build. A drain with more pending rows than the chunk size runs several statements inside one transaction, so a burst is one writer acquisition.

Losses are bounded and stated: a process killed between a record and its drain loses at most one interval of counts. This is acceptable for a view counter, and the alternative — writing inline — puts a write on the hot content path, which issue 5 forbids and which the single SQLite writer makes worse.

`close()` interrupts the fiber, then flushes what is pending, then lets the repository close. A flush that fails is logged and dropped; it never fails a shutdown that already answered every request.

## 2. The tree endpoint

`GET /api/v1/public/tree` needs no credential. For an anonymous viewer it returns every public artifact with its view counts, newest first, except artifacts tagged `unlisted`. An unlisted artifact keeps its public link, so an old path that now redirects after a move can stay reachable without showing on the home page. A signed-in member reads every live artifact instead, with which ones are theirs and which they may change ([Owners, visibility, and the member view](#owners-visibility-and-the-member-view)).

### Why `/api/v1/public/` is anonymous

Every `/api/*` request runs the bearer-or-session middleware (`src/http/create-http-app.ts:873`). The tree must be readable by an anonymous viewer holding nothing, so that middleware skips one prefix:

```ts
app.use("/api/*", async (context, next) => {
  if (context.req.path.startsWith("/api/v1/public/")) return next();
  …
```

A prefix rule rather than an allowlist of exact paths, so the next anonymous read is a naming decision instead of a second edit to the guard. Only `GET` routes are registered under the prefix, the prefix sets no cookie and no CORS headers (AUTH-012), and no mutation route lives there. The tree reads the session cookie itself, only to show a member more, and a missing or invalid one leaves the viewer anonymous rather than failing. Everything an operator can reach stays behind a credential.

`/api/v1/public/` sits inside the reserved roots of section 11 already (`api`), so no artifact path can shadow it and the FRK-003-F route walk stays satisfied.

### Response

```jsonc
{
  "artifactCount": 4,
  "artifacts": [
    {
      "access": "public_link",
      "manage": {
        "artifactId": "art_…",
        "currentVersionId": "ver_…",
        "projectId": "prj_default",
        "tags": ["release"]
      },
      "mine": true,
      "name": "Release checklist",
      "owner": "Alice Example",
      "path": "2026/10/release-checklist",
      "series": [{"count": 2, "day": "2026-10-17"}],
      "updatedAt": "2026-10-17T07:41:02.113Z",
      "updates": [{"count": 1, "day": "2026-10-16"}, {"count": 2, "day": "2026-10-17"}],
      "url": "https://artifacts.example.internal/2026/10/release-checklist/",
      "views": {"last7Days": 2, "last30Days": 2, "total": 2},
      "visibility": "public"
    }
  ],
  "collapsedFolders": [],
  "generatedAt": "2026-10-17T08:00:00.000Z",
  "loginKind": "none",
  "truncated": false,
  "viewer": {"name": "Alice Example"},
  "windowDays": 30
}
```

This is a member's read. An anonymous read has the same fields, with `"manage": null`, `"mine": false`, and `"visibility": "public"` on every row, and `"viewer": null`.

A flat list, not a nested tree. The endpoint reads and shapes; the browser groups and renders. That split keeps the wire format to what the database already returns, keeps one definition of "newest first" instead of two, and lets the grouping be tested as a pure function with no server and no browser.

Field decisions:

- **`name`, not `title`.** Issue 5 says title; the artifact record's field is `name` (`src/core/model.ts:76`) and the page has no other title to show. A renamed field would be a second name for one value.
- **`updatedAt` is the current version's `createdAt`** (`VersionRecord.createdAt`, `src/core/model.ts`). Artifacts have no `updated_at`, and a version's creation is the last change to the artifact. A restored version keeps its own `createdAt`, which is the honest answer for when the visible content was produced.
- **`series` is sparse and ascending.** Days with no views are absent, so the payload stays small on a quiet server. The client densifies against `windowDays`. A dense 30-element array per artifact would be 30 times the bytes for the same information.
- **`updates` counts versions published per UTC day**, in the same window and the same sparse shape as `series`. It is read from `versions.created_at`, the column `updatedAt` already comes from, so it needs no new table. A restore moves the current version without publishing one, so it does not count. Only the artifacts the tree already lists are read, so a private, deleted, or unlisted artifact contributes nothing. Accepted tradeoff: the count includes every version of a currently public artifact in the window, even versions published before it became public. Only the per-day count shows, never the content of those versions.
- **`url` is absolute** and comes from `artifactBrowserUrl` (`src/http/artifact-http-links.ts:4`), the same builder `links.artifact` uses, so the home page can never advertise a URL the server would not serve. In path mode it is `/<path>/`, otherwise `/<folder>/`.
- **`access` is the artifact's access setting**, `public_link` or `account_required`. An anonymous read only ever carries `public_link`.
- **`owner` is the owner's display name or `null`.** It is the name stored when the artifact was created (`ArtifactOwner.displayName`). It is `null` when none was stored, and also when the name holds an email address (text joined to text by an `@` with no space), because the tree never shows an email to anyone, signed in or not. A key published under a name such as `Ada Lovelace @ laptop`, the form `RUNBOOK.md` suggests, holds no address and is shown.
- **`visibility` is `public`, `unlisted`, or `private`**, the three choices the row menu offers. `private` is `access: account_required`; `unlisted` is `public_link` with the `unlisted` tag; anything else is `public`. It is derived on the server so the client has one rule to read, not two fields to combine.
- **`mine` is `true` only when the viewer owns the artifact**, that is, the session principal's ID is the owner's principal ID. It is `false` for an anonymous viewer. The Mine filter reads it.
- **`manage` is the handle the row menu needs to change visibility, or `null`.** It carries the artifact ID, its project, the current version ID that the access and tags APIs take as `expectedCurrentVersionId`, and the sorted tags, so making an artifact unlisted or listed again keeps its other tags. It is non-null exactly when the viewer may change the artifact's settings.
- **`viewer` is `{"name": …}` for a signed-in viewer, from the session principal's display name, or `null`.**
- **`loginKind` is `local_owner` or `none`** from `dependencies.browserAccess` (`src/core/browser-access.ts`). The home page reads it to decide whether to offer a sign-in link. Issue 4 owns the link itself.
- **`windowDays` is 30** and is echoed so the client never hard-codes it.
- **`truncated` is a boolean, never absent.** A client must not have to tell "not truncated" from "the server did not say".

There is no `nextCursor`. The response is the whole catalog the viewer may see for one installation, capped at its 500 newest artifacts. When more exist, `truncated` is `true`, so a partial list never reads as a complete one.

### Owners, visibility, and the member view

The tree reads the application session cookie when one is present. It authenticates it the same way the `/api/*` middleware does (`AuthenticationService.authenticateApplicationSession`), but a missing, malformed, expired, or revoked session reads as anonymous with `200`, never `401`, so a stale cookie cannot break the home page. An `Authorization` header is ignored: the tree is a page read, not an API surface.

- **Which artifacts.** A viewer who passes `requireArtifactListing` (a member, or a key that may read artifacts) reads every live artifact in every project, whatever its access setting and tags, in the same order and under the same 500 cap and `truncated` rule. Anyone else, an anonymous viewer included, reads exactly the anonymous set. One repository read, `listCatalogArtifacts({limit, scope})` with scope `public` or `all`, serves both, so the order and the cap cannot drift between them.
- **Who may change visibility.** `manage` follows `canManageArtifact(principal, artifact)` in `src/application/authorization.ts`: the artifact's owner, a direct human administrator, or a key with `artifact:manage:any`, inside the artifact's installation. An owner match counts only for the person signed in as themselves or a key of theirs that may also create artifacts, so a read-only key on the owner's own principal sees the artifact as theirs (`mine`) but gets no handle. The viewer bar uses the same function for its own control.
- **Collapsed folders.** `collapsedFolders` still names only folders of the listed artifacts, so a member learns a folder that holds only private work and an anonymous viewer does not.
- **Caching.** The body now depends on the session, so the response is `Cache-Control: private, no-cache` with `Vary: Cookie`: the browser revalidates, and no shared cache keeps one viewer's copy for another.

### Reading it

One query for the artifacts, one for their tags, one for the window rows, one for the totals, and one for the versions per day.

```sql
-- artifacts: the 500 newest live artifacts the viewer may see, in every project
SELECT a.id, a.project_id, a.name, a.path, a.access_setting,
       a.owner_principal_id, a.owner_display_name, a.current_version_id,
       v.created_at
  FROM artifacts a JOIN versions v ON v.id = a.current_version_id
 WHERE a.deleted_at IS NULL
   -- the public scope only; the all scope stops at deleted_at
   AND a.access_setting = 'public_link'
   AND NOT EXISTS (SELECT 1 FROM artifact_tags t
                    WHERE t.artifact_id = a.id AND t.tag = 'unlisted')
 ORDER BY a.created_at DESC, a.id DESC
 LIMIT 500;

-- tags for exactly those artifacts, sorted
SELECT artifact_id, tag FROM artifact_tags
 WHERE artifact_id = ANY(…) ORDER BY artifact_id, tag;

-- window rows for exactly those artifacts
SELECT artifact_id, day, count FROM artifact_views
 WHERE artifact_id = ANY(…) AND day >= ? AND day <= ?;

-- all-time totals for exactly those artifacts
SELECT artifact_id, SUM(count) FROM artifact_views
 WHERE artifact_id = ANY(…) GROUP BY artifact_id;

-- versions published per day for exactly those artifacts, through the
-- (project_id, artifact_id) version index
SELECT v.artifact_id, substr(v.created_at, 1, 10) AS day, COUNT(*)
  FROM artifacts a JOIN versions v
    ON v.project_id = a.project_id AND v.artifact_id = a.id
 WHERE a.id = ANY(…) AND substr(v.created_at, 1, 10) BETWEEN ? AND ?
 GROUP BY v.artifact_id, day;
```

Both view queries are bounded by the artifact set the first query returned, so the payload is `O(artifacts × days actually used)`, not `O(all history)`. The totals query has no day bound because "total" is not a window; it reads at most one row per artifact.

The 7-day and 30-day counts are `SUM(count)` over the window's first 7 and all 30 days, computed from the rows the window query already returned. No extra query, and the numbers cannot disagree with `series`.

### Grouping

The grouping is a pure function on the client, because it is display order and display order has one owner.

1. Split each artifact's `path` on `/`. `2026/10/release-checklist` yields `["2026", "10", "release-checklist"]`.
2. The last element is the leaf and the leading elements are the folder chain. An artifact with `path === null` goes to the ungrouped list, which renders last under its own label.
3. Folders are keyed by their full path, so `2026` and `2026/10` are separate nodes and a child always has exactly one parent.
4. Order artifacts by `updatedAt` descending, then `id`. That is "newest first", and `id` breaks ties so the order is total.
5. Order sibling folders by the newest `updatedAt` anywhere beneath them, descending, then `label`. A folder with no artifacts cannot occur, because a folder exists only when an artifact creates it.
6. Label a folder with its last segment, so `2026/10` reads `10` under `2026`, as issue 5's `2026` › `10` requires.

Prefix-free paths (section 11) make step 3 unambiguous: no folder path is also an artifact path, so no node is both a leaf and a branch.

The tree builder lives at `apps/web/src/home/home-tree.ts` and exports `buildPublicArtifactTree`, `densifyDailySeries`, and `sparklineBars`. All three are pure and are tested from `tests/web/home-tree.test.ts`, which imports them directly — the vitest root includes only `tests/**/*.test.ts`.

### The chart

`views` is a per-day count, not a rate, and a single installation is rarely busy enough for a log scale to matter.

- **Home page.** One bar per day summed across every public artifact, 30 days. A switch on the card picks the measure: views per day from `series`, or updated per day from `updates`. The client sums the sparse series it already received, so the headline chart and the rows can never disagree.
- **A day filters the tree.** Clicking a day's column filters the tree to the artifacts viewed on that day, or updated on it in the updates measure. The tree is built from the filtered list, so only folders that hold a match render. A filtered tree opens every folder, including one set to start collapsed, so a match never hides. Clearing the filter returns each folder to its default state. A chip above the tree names the filter ("Updated on 26 Oct") and clears it, as does the same day again. Switching the measure clears the day, because a day means something else in the other measure. Each day with a count is also a real `<button>` laid over its column with `aria-pressed`. It is one tab stop, the arrow keys, Home, and End move between days, and Enter or Space toggles. The buttons let the pointer through, so hovering a column still shows the day's tooltip. A day with no count is not a target, because it would filter to an empty tree.
- **Colour.** Each measure wears one accent token: `--chart-views` (blue) and `--chart-updates` (the theme's orange, `--chart-4` in light and `--chart-3` in dark). Both are in `apps/web/src/theme-tokens.css` and were run through the data-viz palette validator against the card surface in each theme: inside the lightness band, above the chroma floor, at least 3:1 against the card, and far apart under protanopia and deuteranopia. With no day selected every bar is the full accent. A selected day keeps the full accent and every other day recedes to a tint, the accent mixed 80% into the card. The day under the pointer or keyboard focus sits one step between, at 90%. Both tints keep the 3:1 a data-bearing mark needs against the card (WCAG 1.4.11). The 80% tint measures 3.12 (views) and 3.55 (updates) in light, and 3.50 and 3.53 in dark. The 90% tint measures 3.70 and 4.30 in light, and 4.16 and 4.21 in dark. The full accents measure 4.42 to 5.23.
- **Reading it.** A line above the chart gives the window total and the busiest day, the latest one on a tie. A mirrored y axis and hairline gridlines stay in the muted ink. Today's column carries a dot below it, and the right end of the axis reads "Today". Hovering a column, or focusing its day button, shows a tooltip with the date and the count. The page draws that tooltip itself rather than Recharts, so the pointer and the keyboard show the same thing. The tooltip is hidden from assistive tech, because each day button's accessible name already carries the date and the count.
- **Each artifact row.** The name, a visibility badge when the row is not public, the owner's display name, a 30-day sparkline in the views accent, when the artifact last changed, and the row menu. The sparkline uses the same function at 30 bars in a fixed 96×24 box. A row with no views draws the bars at zero height, so the column stays aligned instead of collapsing. The row shows no counts as text: the sparkline is one focusable element whose accessible name and tooltip carry the 7-day, 30-day, and all-time views.
- **Tree controls.** A sort control orders the tree by last updated (the default), name, or most viewed (all-time views). Folders keep grouping, so a sort reorders artifacts inside each folder and orders sibling folders by the same measure over everything beneath them. The browser keeps the choice in `localStorage` under `artifact-server-home-sort`; a page that cannot reach storage, as in some private windows, starts at the default. A signed-in member also gets a **Mine** toggle that keeps only rows whose `mine` is true. The Workbench account menu's **My artifacts** opens `/?mine=1`, which starts with the toggle on.
- **Row menu.** A row whose `manage` handle is not null has a `⋯` button: open, copy link, versions (Review with the artifact selected), rename, and visibility. The labels match the viewer bar's menu. Visibility is public, unlisted, or private and is written through the existing tags and access APIs with the handle's IDs. Each change first reads the artifact again, because the tags write replaces every tag and the tree's copy may be stale. Tags are written before access, so a change never passes through a state that lists the artifact more widely than either end. Giving a private artifact a link asks for confirmation first. The menu closes on a choice, and the tree reads the server again after every attempt, failed or not. Rows without a handle, and every row for an anonymous reader, show no button. The server decides the handle, so the page only shows or hides the button. The menu, the API client, and the toasts load as a separate chunk only for a signed-in reader.

The day chart is `aria-hidden`; its day buttons carry the numbers. Each sparkline's numbers are in its accessible name.

## 3. The page

`/` serves a new application shell instead of redirecting to `/review` (`src/http/create-http-app.ts:839`). `/review` is untouched and stays at its own URL.

- `apps/web/index.html` becomes a third Vite entry next to `review` and `review-frame` (`apps/web/vite.config.ts:13`), so the page ships its own small bundle and never loads Review's code for an anonymous viewer.
- `/` answers `serveWebAsset(context, dependencies, "/index.html", "application-shell")`, which already carries the strict app-shell CSP (`src/http/create-http-app.ts:4210`). The home page is application UI, so it gets that policy and **not** the content sandbox; artifact content keeps `Content-Security-Policy: sandbox` (FRK-002).
- All UI lives in new files under `apps/web/src/home/`: `home-app.tsx`, `home-main.tsx`, `home-client.ts`, `home-tree.ts`, `home.css`. Nothing existing is modified except the `/` route and the Vite entry list, because issue 4 is restyling the app on another branch.
- Colors are only semantic tokens (`--border`, `--muted-foreground`, `--chart-*`), so the shadcn preset in issue 4 lands on this page without an edit.
- The theme lives in `apps/web/src/lib/theme.ts`: the key `artifact-server-theme` holds `light`, `dark`, or `system` (the default), and the resolved theme is a `light` or `dark` class on `<html>`. The home page header and the Workbench account menu set the same key, so one choice applies to the whole application.

### Screenshots

`tests/browser/frk-009-home-page.spec.ts` captures the page at 1280×900 under a dark and a light system setting and runs the axe builder, as `tests/browser/frontend-mvp.spec.ts` does. It runs in CI only; the development machine has no browsers.

## 4. Ledger

Two requirements, because the counting and the tree fail differently.

`FRK-008` owns the counters and the port. `FRK-009` owns the endpoint and the page. `FRK-023` owns the `updates` series, the chart's measure switch, and the day filter on the tree. `FRK-025` owns the chart's colours, its tooltip, today's mark, and the summary line. `FRK-027` owns the owner name, visibility, `mine`, `manage`, and `viewer` fields, the member view, and the row controls that read them. All five carry `status: implementing` with a `proof_gap` that names the Docker-backed work, the same way FRK-006 and FRK-007 do.

## 5. Commits

Branch `feat/homepage-tree`, one pull request. Each commit adds its ledger entry with its tests, because `scripts/check-conformance-test-ids.rb` rejects unknown IDs. Local checks are single test files; Postgres and browser checks run in CI.

The table is shorter than the shape of the change suggested. The counters, the endpoint, the page, and their tests share `src/http/create-http-app.ts`, `src/core/model.ts`, and `src/core/ports.ts`, so splitting them would mean staging hunks inside those files and shipping a commit whose page cannot render. Section 11's commits were split because each had its own file; this work has three files that belong together, so it lands as one commit with its tests, then the browser proof, then the operator docs.

| # | Commit | Check |
| --- | --- | --- |
| 1 | `docs(fork): design the home page tree and view analytics` | This file and the two ledger entries. |
| 2 | `feat(home): list public artifacts as a tree and count their views` | `pnpm typecheck` and `pnpm lint` across all three backends and the web app. `tests/conformance/frk-008-artifact-views.test.ts` (FRK-008-B, FRK-008-F) and `tests/conformance/frk-009-artifact-tree.test.ts` (FRK-009-B, FRK-009-F) drive a real server over temporary disk storage and a temporary SQLite database. `tests/http/artifact-view-recorder.test.ts` drives the recorder against that database: coalescing, one row per day across a midnight, a drain larger than one chunk, and a view recorded while a drain is in flight. `tests/web/home-tree.test.ts` proves the nesting, the `2026` › `10` labels, the one-segment group, the ungrouped list, the series densifier, and the chart geometry with no server and no browser. The SQLite table joins the `CREATE TABLE IF NOT EXISTS` baseline, so `tests/conformance/storage-migration.test.ts` keeps passing unchanged. CI: `tests/integration/external-storage-runtime.test.ts` migrates to `requiredPostgresSchemaVersion`, so `0013` runs. |
| 3 | `test(web): screenshot the home page light and dark` | CI only. `tests/browser/frk-009-home-page.spec.ts` captures the page in both themes and requires a clean axe run in each. |
| 4 | `docs: document the home page tree` | `docs/fork/RUNBOOK.md`. The upstream `README.md` is untouched, because the fork does not modify it. |

## 6. Folder default state

An owner can make one folder of the tree start collapsed, for example `team/archive`. Every other folder starts expanded, as before. A viewer can still open or close any folder.

### Data shape

A folder is not an entity. It exists only while an artifact path names it. So the setting is a set of folder paths that start collapsed, one table with one key:

```sql
-- SQLite, in the #migrate baseline
CREATE TABLE IF NOT EXISTS collapsed_folders (path TEXT PRIMARY KEY) STRICT;

-- Postgres, migration 0020_collapsed_folders
CREATE TABLE collapsed_folders (
  installation_id TEXT NOT NULL,
  path TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (installation_id, path)
);
```

1. **A set, not a state column.** Expanded and unset are the same state, so expanding a folder deletes its row. No row can hold a setting that changes nothing.
2. **Keyed by path across projects.** Readable paths are unique across the installation, and the tree lists every project.
3. **One folder, no inheritance.** A collapsed folder already hides its subfolders. When a viewer opens it, each subfolder starts in its own state.
4. **No foreign key.** A setting can name a folder before an artifact lands there, and it stays when the folder empties.
5. **Not a tag, not configuration.** A tag sits on one artifact, and a new artifact in the folder would not inherit it. A configuration value cannot be set over REST or MCP.

SQLite keeps schema version 17, as `artifact_views` and `assets` did. Postgres needs migration 0020, which is additive and one-way: an older build refuses the newer schema.

### Setting it

`PUT /api/v1/folder-defaults` with `{"path": "team/archive", "defaultState": "collapsed"}`, or the MCP tool `folder_set_default` with the same fields. The path is parsed by the same rules as an artifact path. The caller needs the access that `artifact_set_tags` needs, because folders have no owner and tagging an artifact `unlisted` already does more to the tree than collapsing its folder. The CLI has no command, because it has none for tags or visibility either.

### Reading it

The tree response gains `collapsedFolders`, sorted. It names a folder only when a listed artifact's path is that folder or sits inside it, so an anonymous viewer never learns a folder that holds only private or unlisted work. The page passes `defaultOpen={false}` to those folders. The page keeps no per-viewer folder state, so a viewer's clicks last until the next load, as they did before.

## Open decisions

1. **The anonymous prefix is `/api/v1/public/`, not a `/public` first segment.** A first-segment route would need an entry in `reservedPathRoots` (section 11), and the reserved list is deliberately short.
2. **The endpoint returns a flat list and the browser groups it.** Two definitions of folder order would drift; one owner cannot.
3. **Counts are lost on an unclean shutdown, bounded by one drain interval.** Writing inline would put a database write on every content response.
4. **The response is capped at the 500 newest public artifacts and says so.** A silent cap would read as completeness.
5. **A `304` counts as a view.** A reload is a page load.