# Connect AI agents with MCP

Artifact Server exposes one MCP endpoint at `POST /mcp`. MCP uses the same product operations and permissions as the CLI and HTTP API.

## Connect a client

Start a local server with `artifactserver start`, which listens on `http://localhost:8787`, or use a team server. `artifactserver open` also starts one and prints its address. Create an API key under Settings › API keys. Every client connects to the server's `/mcp` address and sends the key as a bearer token.

Claude Code:

```sh
claude mcp add --transport http artifact-server http://localhost:8787/mcp --header "Authorization: Bearer <key>"
```

Codex, Cursor, and VS Code: add the `/mcp` address as a remote HTTP MCP server with the header `Authorization: Bearer <key>`.

Keep the key in the client's configuration or secret store. Do not paste it into chat.

## Connect to a team server

Add the exact MCP address to the client:

```text
https://artifacts.example.com/mcp
```

Send an API key as a bearer token with every request:

```text
Authorization: Bearer <key>
```

An administrator creates keys under Settings › API keys. A key from another installation does not work.

## Publish from an agent

MCP sends metadata and small results. Artifact files use the staged upload API.

An agent uses this sequence:

1. Call `artifact_capabilities` to read limits and available features.
2. Call `artifact_create_upload` with each path, size, media type, and SHA-256 fingerprint.
3. Upload each file to its returned opaque upload URL.
4. Call `artifact_commit_upload` with the publication target and idempotency key.

When the agent publishes a new version, it first reads the current version ID. It sends that ID as `expectedCurrentVersionId`.

A `new_artifact` target may carry an optional `path`, such as `2026/10/report`. On a server without a content domain, `links.artifact` is then `/<path>/` on the application host, and new versions keep it. The rules match the CLI's [`--path`](./cli.md#choose-a-readable-path). An invalid path returns `INVALID_INPUT` with a message that says what is wrong.

## Use the publication result

Every successful publication returns structured data and a short text summary.

```json
{
  "links": {
    "review": "https://artifacts.example.com/review?...&view=focus",
    "artifact": "https://artifacts.example.com/artifacts/art_example",
    "version": "https://ver-example.content.example.com/"
  }
}
```

The server instructions tell the agent to share `links.review` first. This link opens the exact version full screen with comments.

`links.artifact` follows the current version. `links.version` opens the immutable raw artifact without the Artifact Server interface.

The agent must not place bootstrap URLs, access tokens, or credentials in chat.

Read operations use the same link roles. `artifact_get.current.links.review`
opens the current exact version in full-screen Review. `artifact_open.reviewUrl`
opens the selected exact version in Review, while `artifact_open.browserUrl`
opens its raw immutable content. Agents should hand people the Review URL.

## Check a published folder for broken references

A folder page breaks quietly when it points at a file the version does not contain. A common case is a page that repeats its own folder name. A page served at `https://artifacts.example.internal/reports/q3/` that loads `reports/q3/shots/a.jpg` asks for `/reports/q3/reports/q3/shots/a.jpg`, which does not exist.

Every commit result carries `assetCheck`, the counts for the new version:

```json
{"assetCheck": {"broken": 1, "heuristic": 0}}
```

`assetCheck` is `null` when the check could not run. The check never blocks or fails a publish.

`artifact_check_assets` takes `artifactId` and an optional `versionId`, and lists each reference the version cannot satisfy. The same report is at `GET /api/v1/artifacts/{artifactId}/asset-check` for the current version and `GET /api/v1/artifacts/{artifactId}/versions/{versionId}/asset-check` for an exact one. Both need artifact read access. The CLI prints it with `artifactserver assets check <artifact-id>`, and `artifactserver assets check --all` prints a table for every artifact the key can read.

```json
{
  "references": [
    {
      "file": "index.html",
      "line": 12,
      "kind": "html-attr",
      "raw": "reports/q3/shots/a.jpg",
      "resolvedPath": "reports/q3/shots/a.jpg",
      "confidence": "certain"
    }
  ],
  "summary": {
    "broken": 1,
    "heuristic": 0,
    "checkedFiles": 3,
    "truncated": false,
    "byKind": {"css-import": 0, "css-url": 0, "html-attr": 1, "meta-refresh": 0, "outside": 0, "script": 0}
  }
}
```

The check reads the version's HTML, CSS, and JavaScript files. It resolves each reference the way a browser would from the file's served URL and honors `<base href>`. The entry file is resolved from the artifact root, where its shared link serves it.

| Kind | Source | Confidence |
| --- | --- | --- |
| `html-attr` | `src`, `href` on `link`, `a`, and `area`, `srcset`, `poster`, `data` on `object`, `data-src`, `data-srcset`, and inline `style` | certain |
| `css-url` | `url(...)` in stylesheets and `<style>` | certain |
| `css-import` | `@import` | certain |
| `meta-refresh` | `<meta http-equiv="refresh">` | certain |
| `script` | quoted relative paths with a file extension in scripts | heuristic |
| `outside` | a path outside the artifact's own served path | heuristic |

Other origins, `data:`, `blob:`, `mailto:`, `tel:`, `javascript:`, fragments, and templates such as `${src}` or `{{src}}` are ignored. A subfolder URL such as `pages/` is broken unless the version has that exact file, because the server serves only the entry file at the artifact root. In a single-page application, a missing `a` or `area` link is not reported, since navigation falls back to the entry file.

The check skips files over 1 MiB and stops at 8 MiB and 1,000 files per version and at 1,000 reported references. `summary.truncated` is `true` when a limit was hit.

## Tool groups

| Group | Tools |
| --- | --- |
| Discovery | `artifact_capabilities` |
| Projects | `project_list`, `project_create`, `project_rename`, `project_archive`, `project_unarchive` |
| Artifacts | `artifact_list`, `artifact_get`, `artifact_open`, `artifact_version_list`, `artifact_diff`, `artifact_check_assets` |
| Publication | `artifact_create_upload`, `artifact_commit_upload` |
| Management | `artifact_set_visibility`, `artifact_set_tags`, `artifact_restore_version`, `artifact_delete` |
| Comments | `comment_list`, `comment_get`, `comment_create`, `comment_reply`, `comment_update`, `comment_resolve`, `comment_delete` |

## Install the Artifact Server skill

Install the portable Agent Skill:

```sh
npx skills add plannotator/artifact-server
```

The skill routes artifact work and explicit server-administration work to separate internal instructions. It uses the CLI for files on the developer machine and MCP for server data and agent-held context.

In clients that expose installed skills as slash commands, publish finished work with a request such as:

```text
/artifact-server upload that HTML design doc
```

The agent returns the full-screen review link first so the recipient can view and comment on the exact version.

Read the [MCP product baseline](../project/spec/artifact-server-mcp-baseline.md) for the protocol and authorization contracts.
