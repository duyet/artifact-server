# Local workspace features

**Status:** Accepted; implementation underway — `PRV-001` through `PRV-005` are implemented with local HTTP and browser proof. `KAN-001` through `KAN-007`, `EDT-001` through `EDT-003` remain specified and unimplemented (August 23, 2026). Linked artifacts and open-in were removed in October 2026.
**Date:** August 19, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.md), [Artifact comments](./artifact-comments-spec.md) (the storage and parity precedent this spec follows), [Image and video previews](./media-preview-spec.md), [Conformance ledger](./conformance.yml), [ADR 0024](./decisions/0024-kanban-is-first-class-records.md)

## 1. What this adds and why

The v0 Artifact Server (the July 2026 `@plannotator/artifact-server` 0.1.0) was a single-user local workspace. Three of its features did not survive the rewrite into the current multi-deployment product, and each one still matters to the person running Artifact Server on their own machine next to their agents:

1. **A Kanban board** — a small four-column work tracker per project, usable by people and agents through the same surfaces as everything else.
2. **In-place text editing** — fix a Markdown or text artifact in the browser without a round trip through the CLI.
3. **Broader previews** — see images, video, audio, and PDFs inside the review screen, not only HTML.

v0 could take shortcuts the current product cannot: it had one user, one machine, one mutable copy of each artifact, and no version history. This spec revives the three features **without weakening any current invariant** — versions stay immutable, every mutation stays attributed and idempotent, and untrusted paths never select raw storage.

One of the three requires a real architectural decision, recorded as an ADR:

- The Kanban board meets immutable versions → **ADR 0024: the board is first-class records, not an artifact.** v0's board-as-artifact was elegant because v0 artifacts were mutable; ours are not, so the board follows the comments precedent: repository port, three backends, action records, idempotency, HTTP/MCP/web parity.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Board | One Kanban board per project: four fixed columns and its cards. |
| Card | One work item: title, description, column, position, labels, assignee, paused flag, artifact attachments, revision. |
| Edit commit | A publish that creates a new version by copying the base version's manifest with exactly one text entry replaced by newly uploaded bytes. |

## 3. Kanban board

### 3.1 The decision: first-class records (ADR 0024)

The board is mutable, collaborative, fine-grained state. In v0 it lived inside a mutable artifact; in this product an artifact write is an immutable version, so board-as-artifact would either flood version history (every drag a publish) or require a version-exempt artifact kind (a second artifact semantics through every layer). Comments already solved this exact problem — mutable, project-scoped, attributed records behind a repository port on all three backends — and the board copies that answer.

### 3.2 Model

One board per project, created on first use. Columns are fixed: `backlog`, `in_progress`, `review`, `done` — no column management in v1.

```ts
export interface KanbanCardRecord {
  readonly id: string;                     // "card_" + UUID; client-suppliable for idempotent create
  readonly installationId: string;
  readonly projectId: string;
  readonly columnId: "backlog" | "in_progress" | "review" | "done";
  readonly position: number;               // dense, unique per column
  readonly title: string;                  // 1..200 characters after trim
  readonly description: string;            // 0..20000 characters
  readonly labels: readonly string[];      // ≤ 8, each ≤ 32 chars, case-insensitively unique
  readonly assignee: string | null;        // ≤ 80 characters, free text
  readonly paused: boolean;                // true only while columnId = "in_progress"
  readonly artifactIds: readonly string[]; // ≤ 50, unique, same project
  readonly revision: number;               // per-card optimistic concurrency
  readonly author: CommentAuthor;          // same attribution shape as comments
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules, all enforced in one repository transaction per mutation:

- **Concurrency:** every update and delete names `expectedRevision`; a mismatch is a conflict that returns the current card. Edits to different cards never conflict. (v0's separate board-level revision is dropped: with per-card revisions and server-assigned dense positions there is nothing left for it to protect.)
- **Ordering:** a move names the target column and an optional `beforeCardId`; the server assigns dense positions and repairs gaps. Clients never write raw positions.
- **Attachments** reference artifacts by ID within the same project. A tombstoned or missing artifact leaves the card valid; readers receive the ID with an `available: false` marker and the web application renders a missing-attachment state. Deleting a card never touches artifacts.
- **Idempotency:** create accepts a client-supplied card ID; replaying the same create with identical fields returns the original card; the same ID with different fields is a conflict. Updates and deletes are idempotent under `expectedRevision`.
- **Attribution:** every mutation records the acting principal in the card and appends an action record, exactly like comment mutations.

### 3.3 Access

Reading the board requires artifact-read authority on the project. Mutating it requires an admitted human member or a service key holding the board-write capability (a new capability, granted like comment-write). All operations are project- and installation-scoped; cross-project identifiers answer not-found without disclosure.

### 3.4 Surfaces

| Surface | Contract |
| --- | --- |
| `GET /api/v1/projects/:projectId/kanban` | The board: columns, cards in position order, attachment availability. Supports the same `since` polling discipline as comments. |
| `POST /api/v1/projects/:projectId/kanban/cards` | Create (`201`, or `200` replay on idempotent retry). |
| `PATCH /api/v1/projects/:projectId/kanban/cards/:cardId` | Edit, move (`columnId` + `beforeCardId`), pause, assign, attach — all under `expectedRevision`. |
| `DELETE /api/v1/projects/:projectId/kanban/cards/:cardId?expectedRevision=N` | Delete. |
| MCP | `kanban_get_board`, `kanban_create_card`, `kanban_update_card`, `kanban_delete_card` — same authorization, same shapes, actionable error results carrying the current `{ id, revision }` on conflict. |
| Web application | Four-column board with drag-and-drop and keyboard movement, optimistic reorder reconciled by the guarded `PATCH`, card inspector, per-artifact badge showing non-done cards that attach the open artifact. The v0 interaction design (dnd-kit sensors, collapsed Done column, missing-attachment state, stale-revision "reload card") is the reference. |

Deployments: all six. The board is ordinary database state and works identically everywhere.

## 4. In-place text editing

An edit **is** a publish. There is no mutable write path; the editor produces a new immutable version.

- **Scope:** manifest entries whose media type is `text/*` or `application/json`, at most 2 MiB. Everything else is not editable in v1.
- **Flow:** the web application uploads the edited bytes through the existing staging-upload mechanism, then calls the edit commit: `POST /api/v1/projects/:projectId/artifacts/:artifactId/edits` with `{ baseVersionId, path, uploadId, idempotencyKey, expectedCurrentVersionId }`. The server copies the base version's canonical manifest, replaces exactly the named entry with the verified uploaded bytes, and commits a new version through the normal one-transaction publish path with a publish action record marked as an edit.
- **Conflict:** if the current version moved after the editor loaded, the commit conflicts and returns the actual current version; the editor offers reload-and-reapply or copy-my-changes. It never silently overwrites.
- **Byte fidelity:** the editor preserves the file's UTF-8 BOM and its CRLF/LF line-ending convention on save (v0's `decodeTextDocument`/`encodeEditedMarkdown` behavior is the reference); a file with mixed or CR-only endings prompts before normalizing. Untouched lines round-trip byte-identically.
- **MCP:** none in v1. MCP arguments never carry file contents (product rule); agents edit by publishing through the CLI.

Deployments: all six.

## 5. Broader previews

The first broader-preview slice is specified in [Image and video previews](./media-preview-spec.md). The Artifact Server review interface presents one exact-version image or video with native browser elements, manifest file selection, focus viewing, explicit terminal states, and ranged video seeking.

The authenticated version-file route remains download-only. Native media uses a separate application-origin route that returns the manifest media type only to authenticated same-origin `image` or `video` subresource requests and rejects top-level document navigation. This corrects the earlier assumption that a browser subresource could render the version-file route despite its `application/octet-stream` and `attachment` response. `CMT-013` remains unchanged.

Audio, PDF, and preformatted text presentation are follow-on preview slices, not part of `PRV-001` through `PRV-005`. Everything without an implemented browser-native presentation uses a typed fallback and never renders inline. Comments on non-HTML files keep the existing whole-file anchor. Deployments: all six.

## 6. Security summary

- Board and edit mutations carry the full existing discipline: project scoping, capability checks, idempotency, per-record optimistic concurrency, action records (`KAN-003`, `KAN-006`, `EDT-001`).
- Nothing in this spec adds a content-origin endpoint, weakens the two-origin boundary, or lets artifact JavaScript reach any of the new routes.

## 7. Storage sketch

The board is one table:

```sql
CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  column_id TEXT NOT NULL CHECK (column_id IN ('backlog','in_progress','review','done')),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',       -- JSON array, validated in the service
  assignee TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  artifact_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of same-project artifact IDs
  revision INTEGER NOT NULL DEFAULT 1,
  author_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, column_id, position)
) STRICT;
```

Edits reuse existing tables entirely (staging uploads, versions, manifest entries, actions); previews add no storage.

## 8. Non-goals

- **Column management, swimlanes, board-level webhooks, or cross-project boards.** Four fixed columns.
- **A WYSIWYG or multi-file editor.** One text entry per edit commit.
- **Custom media viewers, transcoding, thumbnails, or annotations positioned inside video/PDF content.** Browser-native rendering only; comments on non-HTML media anchor to the file.
- **An MCP editing tool** (MCP arguments never carry file contents).

## 9. Conformance requirements to add

New ledger module `kanban` (KAN); EDT belongs to `publishing`, PRV to `web-application`. All entries start `specified` with empty evidence.

| ID | One line |
| --- | --- |
| `KAN-001` | Each project has one four-fixed-column board created on first use. |
| `KAN-002` | Cards enforce documented bounds on title, description, labels, assignee, paused, and attachments. |
| `KAN-003` | Card mutations use per-card revisions: cross-card edits merge, same-card conflicts return the current card. |
| `KAN-004` | Ordering is server-assigned dense positions; moves name a column and an optional before-card. |
| `KAN-005` | Attachments reference same-project artifacts by ID and survive artifact deletion as explicit missing attachments. |
| `KAN-006` | Board reads require artifact-read authority; mutations require a human member or board-write capability; everything is project-scoped and action-recorded. |
| `KAN-007` | HTTP, MCP, and the web application expose the same board operations with idempotent creates and since-polling. |
| `EDT-001` | An edit commit publishes a new immutable version replacing exactly one text entry, with idempotency, current-version compare-and-swap, and an action record. |
| `EDT-002` | The editor preserves BOM and line endings and resolves stale saves as explicit conflicts, never silent overwrites. |
| `EDT-003` | Editing is bounded to text media types and sizes, verified like any publish, and absent from MCP. |
| `PRV-001` | The review interface presents an exact-version image with browser-native decoding, contained layout, focus viewing, and no DOM insertion for SVG. |
| `PRV-002` | The review interface presents an exact-version video with native controls, no autoplay, metadata-only preload, and working ranged seeking. |
| `PRV-003` | Authenticated media delivery is same-origin, media-destination-only, correctly typed, range-capable, and cannot become an application-origin document. |
| `PRV-004` | Manifest file selection is URL-addressable, version-pinned, back/forward aware, and protected from stale preview responses. |
| `PRV-005` | Unsupported types, codecs, corrupt media, and delivery failures settle into an honest typed fallback without sniffing, conversion, or an infinite loading state. |

## 10. Sequencing and effort

Recommended build order, matching dependency direction:

1. **Previews** (`PRV`) — days; web-only over existing routes.
2. **Editing** (`EDT`) — under a week; reuses staging uploads and the publish transaction.
3. **Kanban** (`KAN`) — one to two weeks; the pattern is a copy of comments (port, three backends, HTTP+MCP, action records) plus the board UI, for which the v0 interaction design is the reference.

## 11. Open questions

1. **Label vocabulary.** v0 suggested six fixed labels (research/design/implementation/validation/documentation/operations). Keep as suggestions, make configurable per installation, or drop suggestions entirely? Recommendation: keep the six as non-enforced suggestions.
