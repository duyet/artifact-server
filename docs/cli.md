# Command-line interface

Agents normally publish through the [Artifact Server Skill](../skills/artifact-server/SKILL.md) or [MCP](./mcp.md). Use the CLI when you want to publish directly or run operator commands from a terminal.

A packaged release will provide the `artifactserver` command. Its download, verification, and `PATH` setup commands will be added on release day. Until then, run the examples from a source checkout by replacing `artifactserver` with `pnpm artifactserver`.

## Publish an artifact

Publish one finished file or a complete directory:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --public --name "Product prototype" --tag prototype
```

Publication returns JSON with three browser links:

| Link | Purpose |
| --- | --- |
| `links.review` | Opens the exact version full screen with comments. Share this link first. |
| `links.artifact` | Opens the stable link that follows the current version. |
| `links.version` | Opens the immutable raw version without the Artifact Server interface. |

### Choose a readable path

On a server without a content domain, a new artifact can claim one readable path:

```sh
artifactserver publish ./dist --public --name "Agent console" --path 2026/10/agent-console
```

`links.artifact` is then `https://artifacts.example.com/2026/10/agent-console/`, and every new version keeps that link.

- A path has 1 to 6 segments joined by `/` and at most 200 characters. Each segment uses lowercase letters, digits, and hyphens, and starts with a letter or digit.
- The first segment cannot be an application route, such as `api`, `assets`, or `review`.
- Two live paths cannot be equal, and one cannot sit inside the other. `2026/10/report` and `2026/10/report-v2` can both exist, but `2026/10` and `2026/10/report` cannot. A conflict fails with `ARTIFACT_PATH_TAKEN` and names the existing path.
- A path cannot change. Delete the artifact to free its path, then publish again.

A server with a content domain refuses `--path` with `CAPABILITY_UNAVAILABLE`.

## Use a remote server

Sign in once, save a named profile, and use it when publishing:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver publish ./dist --profile team
```

## Publish another version

Provide the artifact ID and expected current version:

```sh
artifactserver publish ./dist \
  --artifact art_example \
  --expected-version ver_example
```

The expected version prevents an old client from replacing a newer current pointer. `--name`, `--path`, `--public`, and `--tag` apply only when creating an artifact, so this command refuses them. A new version keeps the artifact's path.

Run `artifactserver --help` or `artifactserver <command> --help` for the complete command reference.
