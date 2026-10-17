import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  decodeEditableText,
  encodeEditableText,
} from "../../apps/web/src/artifact-actions/text-codec.js";
import {publishEdit} from "../../apps/web/src/artifact-actions/publish-edit.js";
import {
  createBearerTransport,
  renameArtifact,
  type ActionTransport,
} from "../../apps/web/src/artifact-actions/transport.js";
import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const bom = [0xef, 0xbb, 0xbf];
const crlfNotes = Uint8Array.from([
  ...bom,
  ...new TextEncoder().encode("first\r\nsecond\r\nthird\r\n"),
]);
const files: readonly TestSiteFile[] = [
  {
    bytes: new TextEncoder().encode("<h1>Home</h1>\n"),
    mediaType: "text/html; charset=utf-8",
    path: "index.html",
  },
  {bytes: crlfNotes, mediaType: "text/plain; charset=utf-8", path: "notes.txt"},
];

describe("web edit and rename", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let transport: ActionTransport;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    transport = createBearerTransport(server.baseUrl, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function publishSource() {
    const staged = await createStagedUpload(server, installation, "index.html", files);
    await uploadEveryStagedFile(installation, staged.body, files);
    const published = await commitStagedUpload(installation, staged.body, "edt-002-web-source", {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Notes site",
      tags: [],
    });
    return published.body;
  }

  async function readFile(artifactId: string, versionId: string, filePath: string) {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/file?${new URLSearchParams({path: filePath})}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  test("EDT-002-B: editing one line of a BOM+CRLF file publishes a new version with only that line changed", async () => {
    const source = await publishSource();
    const original = await readFile(source.artifact.id, source.version.id, "notes.txt");
    const decoded = decodeEditableText(original);

    const result = await publishEdit(transport, {
      artifactId: source.artifact.id,
      baseVersionId: source.version.id,
      bytes: encodeEditableText({...decoded, text: decoded.text.replace("second", "SECOND")}),
      expectedCurrentVersionId: source.version.id,
      idempotencyKey: "web-edit-edt-002-behavior-key",
      mediaType: "text/plain; charset=utf-8",
      path: "notes.txt",
      projectId: source.version.projectId,
    });

    expect(result.version.number).toBe(2);
    expect(await readFile(source.artifact.id, result.version.id, "notes.txt")).toEqual(
      Uint8Array.from([...bom, ...new TextEncoder().encode("first\r\nSECOND\r\nthird\r\n")]),
    );
    expect(await readFile(source.artifact.id, result.version.id, "index.html")).toEqual(files[0]?.bytes);
    expect(await readFile(source.artifact.id, source.version.id, "notes.txt")).toEqual(crlfNotes);
  });

  test("EDT-002-F: a save against a stale current version is a conflict and publishes nothing", async () => {
    const source = await publishSource();
    const input = {
      artifactId: source.artifact.id,
      baseVersionId: source.version.id,
      expectedCurrentVersionId: source.version.id,
      mediaType: "text/plain; charset=utf-8",
      path: "notes.txt",
      projectId: source.version.projectId,
    };
    const winner = await publishEdit(transport, {
      ...input,
      bytes: new TextEncoder().encode("winner\n"),
      idempotencyKey: "web-edit-edt-002-winner-key",
    });

    await expect(publishEdit(transport, {
      ...input,
      bytes: new TextEncoder().encode("stale loser\n"),
      idempotencyKey: "web-edit-edt-002-loser-key",
    })).rejects.toMatchObject({code: "PUBLISH_CONFLICT", status: 409});

    expect(new TextDecoder().decode(
      await readFile(source.artifact.id, winner.version.id, "notes.txt"),
    )).toBe("winner\n");
  });

  test("FRK-012-B: renaming changes the name without a new version, and a stale rename is a conflict", async () => {
    const source = await publishSource();

    const renamed = await renameArtifact(transport, {
      artifactId: source.artifact.id,
      expectedCurrentVersionId: source.version.id,
      idempotencyKey: "web-rename-frk-012-behavior-key",
      name: "  Renamed site  ",
      projectId: source.version.projectId,
    });
    expect(renamed.artifact.name).toBe("Renamed site");
    expect(renamed.artifact.currentVersionId).toBe(source.version.id);

    await expect(renameArtifact(transport, {
      artifactId: source.artifact.id,
      expectedCurrentVersionId: "ver_stale_does_not_match",
      idempotencyKey: "web-rename-frk-012-stale-key",
      name: "Never applied",
      projectId: source.version.projectId,
    })).rejects.toMatchObject({status: 409});
  });
});
