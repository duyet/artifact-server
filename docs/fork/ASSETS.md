# Asset store

Each artifact has an asset store outside its versions. A page or an agent adds an image, a data file, or other media without saving a version, and the file is served at `/_blob/<id>` on the application origin. This is phase 1 of issue 19. The data store and the page runtime are later phases.

## Data shape

One row in the `assets` table is one file. SQLite creates the table in its baseline, and Postgres adds it in migration `0019_assets`.

| Column | Meaning |
| --- | --- |
| `id` | `ast_<uuid>`, the ID in `/_blob/<id>` |
| `project_id`, `artifact_id` | The artifact that holds the asset |
| `media_type` | A lowercase type from the allowlist |
| `size`, `sha256` | The verified bytes. They are the content-addressed blob that versions use, so identical bytes are stored once. |
| `name` | The name the uploader gave the file. It is a label and never a path. |
| `created_by_principal_id`, `created_by_display_name`, `created_at` | Who added it, and when |
| `idempotency_key`, `input_digest` | The commit or copy that wrote the row. A key is unique per project. |
| `deleted_at` | A tombstone. A deleted asset leaves listings, its URL answers 404, and its quota is freed. |

Deleting an asset never deletes a blob, because a version may hold the same bytes. This follows ADR 0006.

## Allowlist and caps

`src/core/asset-policy.ts` holds the one table of accepted types. Plans, commits, copies, and serving all read it.

| Types | Cap per file | Served |
| --- | --- | --- |
| `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif` | 20 MiB | inline |
| `image/svg+xml` | 2 MiB | inline, with a policy that runs no script |
| `video/mp4`, `video/webm` | 20 MiB | inline |
| `application/pdf`, `font/woff`, `font/woff2` | 20 MiB | attachment |
| `text/css`, `text/javascript` | 16 MiB | inline, UTF-8 |
| `text/csv`, `application/json`, `text/markdown`, `text/plain` | 20 MiB | inline, UTF-8 |

HTML and XML are never accepted, so an uploaded file never becomes a page. A media type is matched on its essence, so `application/json; charset=utf-8` is stored as `application/json`. Any other type gets `415 ASSET_TYPE_UNSUPPORTED`. PDF downloads because a sandboxed document cannot host a PDF viewer.

Each artifact has a quota of 500 assets and 512 MiB. `ARTIFACT_SERVER_ASSET_QUOTA_COUNT` and `ARTIFACT_SERVER_ASSET_QUOTA_BYTES` change it for compact and external-storage servers.

The type cap and the quota are checked when the plan is created, before any byte is sent. The commit checks them again before the bytes reach the blob store, because a plan made for a version skipped the allowlist. The repository then checks the quota a third time under the lock that writes the row: SQLite's single writer, or a Postgres advisory lock per artifact. Two commits that each fit cannot both pass when together they do not. A refusal is `413 ASSET_LIMIT_EXCEEDED`.

## API

Every route takes the optional `projectId` query, as the other artifact routes do. Writes need permission to publish versions of the artifact: an owner, an `artifact:publish:any` key, or the artifact's creator with `artifact:create`. Reads need `artifact:read`.

| Route | Does |
| --- | --- |
| `POST /api/v1/artifacts/{artifactId}/assets/uploads` | Plan one asset from `{mediaType, name, sha256, size}`. Returns `uploadId`, `file.uploadUrl`, and `commitUrl`. |
| `PUT {file.uploadUrl}` | Send the exact bytes. This is the version upload `PUT`, with the same checks and byte cap. |
| `POST /api/v1/artifacts/{artifactId}/assets` | Commit `{uploadId}` with an `Idempotency-Key`. Answers 201 with `{asset, replayed: false}`, or 200 with the original asset when the key repeats. |
| `POST /api/v1/artifacts/{artifactId}/assets/copies` | Copy `{sourceArtifactId, sourceAssetId}` from an artifact in the same project with an `Idempotency-Key`. No bytes move. |
| `GET /api/v1/artifacts/{artifactId}/assets` | `{assets, quota, usage}`, oldest first |
| `DELETE /api/v1/artifacts/{artifactId}/assets/{assetId}` | Tombstone one asset and return it |

An asset is:

```json
{
  "createdAt": "2026-10-23T08:00:00.000Z",
  "createdBy": {"displayName": "Publisher", "principalId": "key_..."},
  "id": "ast_3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "mediaType": "image/png",
  "name": "chart.png",
  "sha256": "...",
  "size": 48213,
  "url": "https://artifacts.example.com/_blob/ast_3fa85f64-5717-4562-b3fc-2c963f66afa6"
}
```

The asset store works only without a content domain. A host-mode server answers `501 CAPABILITY_UNAVAILABLE` to a plan, commit, or copy, because only path mode puts the content sandbox on the application origin.

The MCP tools `asset_create_upload`, `asset_commit_upload`, `asset_list`, `asset_copy`, and `asset_delete` call the same service. `docs/mcp.md` describes them.

## Serving

`GET /_blob/<id>` serves a live asset of a live `public_link` artifact. An asset of an `account_required` artifact is `401 CONTENT_NOT_PUBLIC`, and an unknown or deleted one is `404 ASSET_NOT_FOUND`. `HEAD`, ranges, and `If-None-Match` work as they do for version files.

Every response carries:

- `Content-Type` from the allowlist, and `X-Content-Type-Options: nosniff`.
- Two policies, which a browser enforces together: the content sandbox that every same-host content response carries, and `sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`. An asset opened at top level, an SVG included, runs no script and loads nothing.
- `Cache-Control: public, no-cache, must-revalidate` with the SHA-256 as the `ETag`. One ID always names the same bytes, so a revalidation is a cheap `304`, but a cache still asks first: after a delete or a change to private, the next request is refused instead of served from a stale copy. Pages use the same policy.
- `Content-Disposition: inline` for the inline types above and `attachment` for the rest.
- `Access-Control-Allow-Origin: *`, so a sandboxed page can `fetch` its own JSON or CSV.

`_blob` cannot be an artifact path, because a path segment must start with a letter or a digit.

## Version upload byte cap

The upload `PUT` that versions and assets share has a byte cap. Every file slot of a staged upload has the byte length its plan declared. The upload `PUT` never stores more than that:

- A request whose `Content-Length` is larger than the declared size gets `413 UPLOAD_TOO_LARGE`. The server answers before it reads any of the body.
- A body sent without a length is read through the verified stream, which fails at the first chunk past the declared size with `422 INVALID_INPUT`.

In both cases the slot stays unverified, so the upload cannot commit until a correct body arrives.
