# Home page tree and view analytics

This section is the design for issue 5, the home page at `/`. Citations are against `748e704`. It follows section 11 of `docs/fork/DESIGN.md`, which made artifacts claim a readable path; this document consumes those paths and adds the view counters that the tree shows.

The shape follows `https://html.duyet.net/` and its source `duyet/sharehtml`. That deployment's design note (`DESIGN.md`, "sharehtml Design System — Paper") makes the rules this page copies:

- Structure comes from 1px hairlines, not shadows or color. One bordered box, cells split by vertical hairlines.
- Doc lists are rows separated by hairlines, with muted right-aligned meta.
- Sans for everything, `font-variant-numeric: tabular-nums` for every number, so counts do not jitter as they change.
- Light and dark are the same primitives with different values.

The Artifact Server web app already has that token set (`apps/web/src/theme-tokens.css`: `--border`, `--muted-foreground`, `--chart-1` to `--chart-5`), so the home page uses those tokens and adds no colors of its own. Issue 4 applies the shadcn preset `b3kI32KO0` to the same tokens; this page reads them, so the preset lands on it without an edit.

## 1. Data shape

Views are counts of one thing: a browser asked for an artifact's entry document. They are not events, so they are one table and no event log. The table has exactly the three columns the brief names, and nothing else.

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

1. **`day` is a `TEXT` UTC calendar day, `YYYY-MM-DD`.** Not a timestamp and not a date type, so SQLite and Postgres agree byte for byte and a row is comparable with `<=` and `>=` as text. Day boundaries are UTC because that is the only zone the deployment's logs and the artifact `createdAt` values are already normalized to. A local-time zone would need a stored offset and a calendar library for no product gain.
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
| `GET /2026/10/agent-console/` | yes | The page view. |
| `GET /2026/10/agent-console/index.html` | yes | The same entry document by name. |
| `GET /2026/10/agent-console/settings/profile` on an SPA | yes | The client route resolved to the entry document; a browser navigation happened. |
| `GET /2026/10/agent-console/assets/a.css` | no | An asset, not a page. |
| `HEAD` on any of the above | no | A probe, not a page load. |
| `304 Not Modified` on the entry document | yes | A reload is a view. The browser asked again and was told the page was current. |
| `/v/<token>/…`, a folder `/<slug>-<uuid>/…`, a path `/<path>/…` | yes | All three forms end at `serveVersionContent` (`src/http/create-http-app.ts:3529`), so one call site covers them. |
| A Review lease, `/v/review-<token>/…`, a live source, a bootstrap exchange | no | A lease renders one artifact's version inside another surface. Counting it would charge the operator for previewing their own work and would double the number when the same page is also open at its own URL. |
| A 404 or a 401 at an artifact URL | no | No document was served. |

The call sits in `serveVersionContent` after `authorizeVersionContent` returns and before the response is built:

```ts
if (context.req.method === "GET" &&
    (requestedPath === "" || requestedPath === content.entry.path)) {
  dependencies.artifactViews?.record(content.artifactId);
}
```

`requestedPath` is `""` for `/` and the manifest path otherwise (`src/manifest/create-manifest.ts:73`). `content.entry.path` is the version's own entry path, so the check names the document rather than a URL shape.

### Written without blocking the response

`record` is synchronous, in-memory, and total. It is a `Map` increment keyed by `` `${artifactId}\u0000${day}` `` and cannot fail, await, or touch a database. The content response never waits for a counter.

The drain is a background loop, built exactly like `src/lifecycle/staging-cleanup.ts`: `runtime.runFork(Effect.repeat(pass, Schedule.spaced(intervalMilliseconds)))` with a closer that interrupts the fiber and then flushes the remainder (`src/lifecycle/staging-cleanup.ts:84`). Two files:

- `src/application/artifact-view-recorder.ts` — the recorder. A value, not an Effect service, because the content path must call it synchronously. It takes its clock as the existing `Clock` port (`src/core/ports.ts:720`), which is already synchronous, so tests can pin the day.
- `src/lifecycle/artifact-view-collection.ts` — the loop and the policy, mirroring `StagingCleanupPolicy`.

The drain writes in chunks of at most 500 rows. SQLite binds 2 parameters per row (the value plus nothing, since `ON CONFLICT` names its own columns), and `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds; 500 rows stay under it on any build. A drain with more pending rows than the chunk size runs several statements inside one transaction, so a burst is one writer acquisition.

Losses are bounded and stated: a process killed between a record and its drain loses at most one interval of counts. This is acceptable for a view counter, and the alternative — writing inline — puts a write on the hot content path, which the brief forbids and which the single SQLite writer makes worse.

`close()` interrupts the fiber, then flushes what is pending, then lets the repository close. A flush that fails is logged and dropped; it never fails a shutdown that already answered every request.

## 2. The tree endpoint

`GET /api/v1/public/tree` is anonymous. It returns public artifacts as a nested folder tree with counts.

### Why `/api/v1/public/` is anonymous

Every `/api/*` request runs the bearer-or-session middleware (`src/http/create-http-app.ts:873`). The tree must be readable by a VPN viewer holding nothing, so that middleware skips one prefix:

```ts
app.use("/api/*", async (context, next) => {
  if (context.req.path.startsWith("/api/v1/public/")) return next();
  …
```

A prefix rule rather than an allowlist of exact paths, so the next anonymous read is a naming decision instead of a second edit to the guard. Only `GET` routes are registered under the prefix, the prefix carries no cookie and no CORS headers (AUTH-012), and no mutation route lives there. Everything an operator can reach stays behind a credential.

`/api/v1/public/` sits inside the reserved roots of section 11 already (`api`), so no artifact path can shadow it and the FRK-003-F route walk stays satisfied.

### Response

```jsonc
{
  "artifactCount": 4,
  "folders": [
    {
      "artifacts": [
        {
          "access": "public_link",
          "name": "Agent console",
          "path": "2026/10/agent-console",
          "series": [{"count": 2, "day": "2026-10-17"}],
          "updatedAt": "2026-10-17T07:41:02.113Z",
          "url": "https://artifacts.example.internal/2026/10/agent-console/",
          "views": {"last7Days": 3, "last30Days": 9, "total": 41}
        }
      ],
      "folders": [],
      "label": "10",
      "path": "2026/10",
      "views": {"last7Days": 3, "last30Days": 9, "total": 41}
    }
  ],
  "generatedAt": "2026-10-17T08:00:00.000Z",
  "loginKind": "none",
  "series": [{"count": 2, "day": "2026-10-17"}],
  "truncated": false,
  "ungrouped": {"artifacts": [], "folders": [], "label": "Ungrouped", "path": null, "views": null},
  "views": {"last7Days": 3, "last30Days": 9, "total": 41},
  "windowDays": 30
}
```

Field decisions:

- **`name`, not `title`.** The brief says title; the artifact record's field is `name` (`src/core/model.ts:76`) and the page has no other title to show. A renamed field would be a second name for one value.
- **`updatedAt` is the current version's `createdAt`** (`VersionRecord.createdAt`, `src/core/model.ts`). Artifacts have no `updated_at`, and a version's creation is the last change to the artifact. A restored version keeps its own `createdAt`, which is the honest answer for when the visible content was produced.
- **`series` is sparse and ascending.** Days with no views are absent, so the payload stays small on a quiet server. The client densifies against `windowDays`. A dense 30-element array per artifact would be 30 times the bytes for the same information.
- **`url` is absolute** and comes from `artifactBrowserUrl` (`src/http/artifact-http-links.ts:4`), the same builder `links.artifact` uses, so the home page can never advertise a URL the server would not serve. In path mode it is `/<path>/`, otherwise `/<folder>/`.
- **`access` is always `public_link`.** The field exists so the client does not have to assume, and so issue 4 can widen the endpoint to authenticated callers without changing the item shape.
- **`ungrouped` has `path: null` and `views: null`.** Its `views` is null because summing the artifacts' own totals would need a second aggregate and no caller needs it; the page shows the artifacts.
- **`loginKind` is `none`, `oidc`, or `workos`** from `dependencies.browserAccess` (`src/core/browser-access.ts`). The home page reads it to decide whether to offer a sign-in link. Issue 4 owns the link itself.
- **`windowDays` is 30** and is echoed so the client never hard-codes it.
- **`truncated` is a boolean, never absent.** A client must not have to tell "not truncated" from "the server did not say".

There is no `nextCursor`. The tree is the whole public catalog for one installation, capped at the 500 newest public artifacts. When more exist, `truncated` is `true`, so a partial list never reads as a complete one.

### Reading it

One query for the artifacts, one for the window rows, one for the totals.

```sql
-- artifacts: the 500 newest live public artifacts, in every project
SELECT id, name, path, access_setting, current_version_id
  FROM artifacts
 WHERE deleted_at IS NULL AND access_setting = 'public_link'
 ORDER BY created_at DESC, id DESC
 LIMIT 500;

-- window rows for exactly those artifacts
SELECT artifact_id, day, count FROM artifact_views
 WHERE artifact_id = ANY(…) AND day >= ? AND day <= ?;

-- all-time totals for exactly those artifacts
SELECT artifact_id, SUM(count) AS total FROM artifact_views
 WHERE artifact_id = ANY(…) GROUP BY artifact_id;
```

Both view queries are bounded by the artifact set the first query returned, so the payload is `O(artifacts × days actually used)`, not `O(all history)`. The totals query has no day bound because "total" is not a window; it reads at most one row per artifact.

### Grouping

The grouping is a pure function, not SQL, because it is the product behavior and it must be unit-tested without a database.

1. Split each artifact's `path` on `/`. `2026/10/agent-console` yields `["2026", "10", "agent-console"]`.
2. The last element is the leaf; the leading elements are the folder chain. An artifact with `path === null` goes to `ungrouped`.
3. Folders are keyed by their full path, so `2026` and `2026/10` are separate nodes and a child always has one parent.
4. Order artifacts by `updatedAt` descending, then `id`. That is "newest first", and `id` breaks ties so the order is total.
5. Order sibling folders by the newest `updatedAt` anywhere beneath them, descending, then `label`. A folder with no artifacts cannot occur, because a folder exists only when an artifact creates it.
6. Label a folder with its last segment, so `2026/10` reads `10` under `2026`, as the brief's `2026` › `10` requires.

Prefix-free paths (section 11) make step 3 unambiguous: no folder path is also an artifact path, so no node is both a leaf and a branch.

The tree builder lives at `apps/web/src/home/home-tree.ts` and exports `buildPublicArtifactTree`, `densifyDailySeries`, and `sparklineHeights`. All three are pure and are tested from `tests/web/home-tree.test.ts`, which imports them directly — the vitest root includes only `tests/**/*.test.ts`.

### The chart

`views` is a per-day count, not a rate, and a server is not busy enough for a log scale to matter.

- **Home page.** One bar per day across all public artifacts, 30 days, `--chart-2` bars on `--muted` for zero days. Rendered as inline SVG from `sparklineHeights`, so it needs no chart library, no measurement, and no client bundle for a shape that is 30 `<rect>` elements.
- **Each artifact row.** The same function at 30 bars in a fixed 96×24 box, beside the total. A row with no views renders a flat baseline rather than an empty box, so the column stays aligned.

Both charts are labelled with `aria-label` carrying the numbers in words, and the SVG is `aria-hidden` with a visually hidden table beside it, because a chart nobody can read is not an accessible chart.

## 3. The page

`/` serves a new application shell instead of redirecting to `/review` (`src/http/create-http-app.ts:839`). `/review` is untouched and stays at its own URL.

- `apps/web/index.html` becomes a third Vite entry next to `review` and `review-frame` (`apps/web/vite.config.ts:13`), so the page ships its own small bundle and never loads Review's code for an anonymous viewer.
- `/` answers `serveWebAsset(context, dependencies, "/index.html", "application-shell")`, which already carries the strict app-shell CSP (`src/http/create-http-app.ts:4210`). The home page is application UI, so it gets that policy and **not** the content sandbox; artifact content keeps `Content-Security-Policy: sandbox` (FRK-002).
- All UI lives in new files under `apps/web/src/home/`: `home-app.tsx`, `home-main.tsx`, `home-client.ts`, `home-tree.ts`, `home.css`. Nothing existing is modified except the `/` route and the Vite entry list, because issue 4 is restyling the app on another branch.
- Colors are only semantic tokens (`--border`, `--muted-foreground`, `--chart-*`), so the shadcn preset in issue 4 lands on this page without an edit.
- The theme key is `artifact-review-theme` with values `dawn` and `moon`, the same one `apps/web/src/review/main.tsx` uses, so one choice applies to the whole application and there is no second theme system.

### Screenshots

`tests/browser/frk-009-home-page.spec.ts` captures the page at 1280×900 in `moon` and in `dawn` and runs the axe builder, as `tests/browser/frontend-mvp.spec.ts` does. It runs in CI only; the development machine has no browsers.

## 4. Ledger

Two requirements, because the counting and the tree fail differently.

`FRK-008` owns the counters and the port. `FRK-009` owns the endpoint and the page. Both carry `status: implementing` with a `proof_gap` that names the Docker-backed work, the same way FRK-006 and FRK-007 do.

## 5. Commits

Branch `feat/homepage-tree`, one pull request. Each commit adds its ledger entry with its tests, because `scripts/check-conformance-test-ids.rb` rejects unknown IDs. Local checks are single test files; Postgres and browser checks run in CI.

| # | Commit | Check |
| --- | --- | --- |
| 1 | `docs(fork): design the home page tree and view analytics` | This file and the two ledger entries. |
| 2 | `feat(storage): add the artifact view table` | `tests/conformance/frk-008-artifact-views.test.ts` FRK-008-B builds the table by starting a server on an empty directory, publishes two artifacts, reads entry documents, and observes the counts through the tree endpoint. `pnpm typecheck` covers all three backends. CI: `tests/integration/external-storage-runtime.test.ts` migrates to `requiredPostgresSchemaVersion`, so `0013` runs. |
| 3 | `feat(views): record entry-document views without blocking` | FRK-008-F. B: views stay buffered until a drain, and a burst larger than the drain chunk lands exactly once per artifact. F: HEAD, assets, 404s, private artifacts, and Review leases add nothing; the table holds exactly three columns; a content response never waits for the drain. |
| 4 | `feat(http): serve the public artifact tree` | `tests/conformance/frk-009-artifact-tree.test.ts` FRK-009-B. B: nesting, `2026` › `10` labels, newest-first order, the ungrouped group, sparse series, 7/30-day and all-time totals, and `url` from `artifactBrowserUrl`. F: a private or deleted artifact is absent, no credential is needed, `/api/v1/artifacts` still needs one, `/` carries no sandbox header, and a path-shaped artifact cannot shadow the endpoint. |
| 5 | `feat(web): render the home page tree` | `tests/web/home-tree.test.ts` proves the pure tree builder, the series densifier, and the chart geometry. `pnpm --filter @artifact-server/web typecheck`. |
| 6 | `test(web): screenshot the home page light and dark` | CI only. The axe run must be clean in both themes. |
| 7 | `docs: document the home page tree` | This file, `README.md`, and `docs/fork/RUNBOOK.md`. |

The `PublishedVersion` used for `updatedAt` needs no new read: `listPublicArtifacts` returns the artifact row and its current version in one query, the same shape `ArtifactListItem` already has (`src/core/model.ts:141`).

## Open decisions

1. **The anonymous prefix is `/api/v1/public/`, not a `/public` first segment.** A first-segment route would need an entry in `reservedPathRoots` (section 11), and the reserved list is deliberately short.
2. **`ungrouped` is one group, not one group per artifact.** An artifact with no path has no folder to nest under, so they collect under one label at the end.
3. **Counts are lost on an unclean shutdown, bounded by one drain interval.** Writing inline would put a database write on every content response.
4. **The tree is the 500 newest public artifacts and says so.** A silent cap would read as completeness.
5. **A `304` counts as a view.** A reload is a page load.