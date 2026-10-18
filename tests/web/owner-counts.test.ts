import {describe, expect, test} from "vitest";

import {ownedArtifactCounts} from "../../apps/web/src/review/catalog/owner-counts.js";

const ownedBy = (principalId: string) => ({owner: {displayName: null, principalId}});

const wholeProject = {
  error: null,
  filtered: false,
  items: [ownedBy("member_a"), ownedBy("member_b"), ownedBy("member_a")],
  loading: false,
  nextCursor: null,
  ownerScope: "all",
} as const;

describe("owned artifact counts", () => {
  test("count each owner's artifacts when the catalog is the whole project", () => {
    const counts = ownedArtifactCounts(wholeProject);
    expect(counts?.get("member_a")).toBe(2);
    expect(counts?.get("member_b")).toBe(1);
  });

  test.each([
    ["a later page exists", {nextCursor: "page-2"}],
    ["a search or filter hides artifacts", {filtered: true}],
    ["only one owner's artifacts are listed", {ownerScope: "me"}],
    ["the list is still loading", {loading: true}],
    ["the last load failed", {error: new Error("offline")}],
  ] as const)("are unknown when %s, so the hover card omits the number", (_reason, change) => {
    expect(ownedArtifactCounts({...wholeProject, ...change})).toBeNull();
  });
});
