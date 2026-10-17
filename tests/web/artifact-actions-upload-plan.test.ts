import {describe, expect, test} from "vitest";

import {
  editableEntries,
  defaultEditablePath,
  isEditableMediaType,
  maximumEditableBytes,
} from "../../apps/web/src/artifact-actions/editable-entries.js";
import {
  buildUploadPlan,
  planFromManifest,
  sha256Hex,
} from "../../apps/web/src/artifact-actions/upload-plan.js";

const encoder = new TextEncoder();

function entry(path: string, mediaType: string, size = 10) {
  return {
    disposition: "inline" as const,
    mediaType,
    path,
    sha256: "a".repeat(64),
    size,
  };
}

describe("upload plan", () => {
  test("FRK-013-B: sha256Hex matches the published digests of known inputs", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("EDT-001-B: an edit plan declares exactly the edited file with its size, digest, and media type", async () => {
    const plan = await buildUploadPlan({
      entryPath: "docs/readme.md",
      files: [{
        bytes: encoder.encode("abc"),
        mediaType: "text/markdown; charset=utf-8",
        path: "docs/readme.md",
      }],
      routingMode: "static",
    });

    expect(plan).toEqual({
      entryPath: "docs/readme.md",
      files: [{
        mediaType: "text/markdown; charset=utf-8",
        path: "docs/readme.md",
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        size: 3,
      }],
      routingMode: "static",
    });
  });

  test("FRK-013-B: a duplicate plan is read from the manifest, keeping entry page and routing mode", () => {
    const plan = planFromManifest({
      entries: [
        entry("index.html", "text/html; charset=utf-8", 120),
        entry("assets/logo.png", "image/png", 4_096),
      ],
      entryPath: "index.html",
      routingMode: "spa",
    });

    expect(plan).toEqual({
      entryPath: "index.html",
      files: [
        {mediaType: "text/html; charset=utf-8", path: "index.html", sha256: "a".repeat(64), size: 120},
        {mediaType: "image/png", path: "assets/logo.png", sha256: "a".repeat(64), size: 4_096},
      ],
      routingMode: "spa",
    });
  });
});

describe("editable entries", () => {
  test("EDT-003-B: text, JSON, JavaScript, SVG, and structured-suffix media types are editable regardless of parameters", () => {
    const editable = [
      "text/html; charset=utf-8",
      "text/markdown",
      "text/plain",
      "application/json",
      "application/json; charset=utf-8",
      "application/javascript",
      "image/svg+xml",
      "application/ld+json",
      "application/atom+xml",
      "TEXT/CSS",
    ];

    expect(editable.filter((mediaType) => !isEditableMediaType(mediaType))).toEqual([]);
  });

  test("EDT-003-F: binary media types are not editable", () => {
    const binary = [
      "image/png",
      "application/octet-stream",
      "application/pdf",
      "application/zip",
      "video/mp4",
      "application/wasm",
    ];

    expect(binary.filter((mediaType) => isEditableMediaType(mediaType))).toEqual([]);
  });

  test("EDT-003-F: the mirrored size bound is 1 MiB", () => {
    expect(maximumEditableBytes).toBe(1_048_576);
  });

  test("EDT-001-B: the editor lists only text entries and opens the entry page first when it is text", () => {
    const entries = [
      entry("assets/logo.png", "image/png"),
      entry("style.css", "text/css; charset=utf-8"),
      entry("index.html", "text/html; charset=utf-8"),
    ];

    expect(editableEntries(entries).map((candidate) => candidate.path))
      .toEqual(["style.css", "index.html"]);
    expect(defaultEditablePath(entries, "index.html")).toBe("index.html");
    expect(defaultEditablePath(entries, "assets/logo.png")).toBe("style.css");
    expect(defaultEditablePath([entry("a.png", "image/png")], "a.png")).toBeNull();
  });
});
