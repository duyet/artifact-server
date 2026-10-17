import {describe, expect, test} from "vitest";

import {ancestorFolderPaths, buildPathTree} from "../../apps/web/src/lib/path-tree.js";

const split = (path: string): readonly string[] => path.split("/");

describe("path tree", () => {
  test("nests files under their folders with folders listed before files", () => {
    const tree = buildPathTree(
      ["index.html", "assets/app.js", "assets/img/logo.png", "about.html"],
      split,
    );

    expect(tree).toEqual([
      {
        children: [
          {
            children: [
              {item: "assets/img/logo.png", kind: "leaf", name: "logo.png", path: "assets/img/logo.png"},
            ],
            kind: "folder",
            name: "img",
            path: "assets/img",
          },
          {item: "assets/app.js", kind: "leaf", name: "app.js", path: "assets/app.js"},
        ],
        kind: "folder",
        name: "assets",
        path: "assets",
      },
      {item: "index.html", kind: "leaf", name: "index.html", path: "index.html"},
      {item: "about.html", kind: "leaf", name: "about.html", path: "about.html"},
    ]);
  });

  test("keeps two artifacts that share a name as two rows", () => {
    const artifacts = [
      {id: "art_1", name: "Findings Register"},
      {id: "art_2", name: "Findings Register"},
    ];

    const tree = buildPathTree(artifacts, (artifact) => [artifact.name]);

    expect(tree.map((node) => node.kind === "leaf" ? node.item.id : node.path))
      .toEqual(["art_1", "art_2"]);
  });

  test("drops empty segments so a trailing slash does not invent a folder", () => {
    const tree = buildPathTree(["/2026//10/report/"], split);

    expect(tree).toEqual([{
      children: [{
        children: [{item: "/2026//10/report/", kind: "leaf", name: "report", path: "2026/10/report"}],
        kind: "folder",
        name: "10",
        path: "2026/10",
      }],
      kind: "folder",
      name: "2026",
      path: "2026",
    }]);
  });

  test("names every folder that must open to reveal a nested file", () => {
    expect(ancestorFolderPaths("assets/img/logo.png")).toEqual(["assets", "assets/img"]);
    expect(ancestorFolderPaths("index.html")).toEqual([]);
  });
});
