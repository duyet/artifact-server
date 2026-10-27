import {readFile} from "node:fs/promises";
import path from "node:path";

import {describe, expect, test} from "vitest";

const webRoot = path.resolve(import.meta.dirname, "../../dist/web");

// The review frame runs on the application origin with inline script allowed
// and renders reviewers' comment text, so a renderer that turns text into
// HTML there would be script injection with the session's authority.
const forbiddenMarkers = [
  "insertAdjacentHTML",
  "createContextualFragment",
  "document.write(",
  "katex-mathml",
  "hljs",
  "mermaid.initialize",
  "marked.parse",
];

async function reviewFrameScripts(): Promise<readonly string[]> {
  const page = await readFile(path.join(webRoot, "review-frame.html"), "utf8");
  return [...new Set(page.match(/assets\/[^"']+\.js/gu) ?? [])];
}

describe("review frame bundle", () => {
  test("foundation: the compiled review frame ships no HTML renderer for comment text", async () => {
    const scripts = await reviewFrameScripts();
    expect(scripts.length).toBeGreaterThan(0);
    const sources = await Promise.all(scripts.map(async (script) => ({
      script,
      source: await readFile(path.join(webRoot, script), "utf8"),
    })));
    const found = sources.flatMap(({script, source}) =>
      forbiddenMarkers
        .filter((marker) => source.includes(marker))
        .map((marker) => `${script}: ${marker}`));
    expect(found).toEqual([]);
  });
});
