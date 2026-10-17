import {describe, expect, test} from "vitest";

import {
  buildFileTree,
  changedFiles,
  foldersToReveal,
  parseTagList,
} from "../../apps/web/src/review/inspectors/inspector-model.js";

describe("inspector file tree", () => {
  test("lists folders before files and sorts each level by path regardless of manifest order", () => {
    const tree = buildFileTree([
      {path: "z.html"},
      {path: "docs/b.md"},
      {path: "a.html"},
      {path: "docs/a.md"},
    ]);

    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "folder:docs",
      "leaf:a.html",
      "leaf:z.html",
    ]);
    const docs = tree[0];
    expect(docs?.kind === "folder" ? docs.children.map((node) => node.path) : []).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  test("reveals every folder between the root and the selected file, and none for a root file", () => {
    expect([...foldersToReveal("assets/img/logo.png")]).toEqual(["assets", "assets/img"]);
    expect(foldersToReveal("index.html").size).toBe(0);
  });
});

describe("inspector tag list", () => {
  test("trims tags and drops empty entries so saving replaces the set with clean values", () => {
    expect(parseTagList(" approved ,, release,  ")).toEqual(["approved", "release"]);
    expect(parseTagList("")).toEqual([]);
  });
});

describe("inspector comparison summary", () => {
  test("shows renames as from-to and keeps added, changed, removed, renamed order", () => {
    const comparison = {
      added: [{path: "new.txt"}],
      changed: [{after: {path: "kept.txt"}}],
      removed: [{path: "gone.txt"}],
      renamed: [{from: {path: "old.txt"}, to: {path: "moved.txt"}}],
    };

    expect(changedFiles(comparison)).toEqual([
      {kind: "Added", path: "new.txt"},
      {kind: "Changed", path: "kept.txt"},
      {kind: "Removed", path: "gone.txt"},
      {kind: "Renamed", path: "old.txt → moved.txt"},
    ]);
  });
});
