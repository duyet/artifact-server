import {describe, expect, test} from "vitest";

import {
  principalInitials,
  principalLabel,
  principalName,
} from "../../apps/web/src/review/principal-name.js";

// Artifacts published before names were recorded carry only a principal ID.
const unnamed = (principalId: string) => ({displayName: null, principalId});

describe("principal names", () => {
  test("the signed-in principal reads as You, even when it has a recorded name", () => {
    expect(principalLabel({displayName: "Ada Lovelace", principalId: "member_1"}, "member_1"))
      .toBe("You");
    expect(principalLabel(unnamed("local-api-token"), "local-api-token")).toBe("You");
  });

  test("a recorded display name wins over the ID shape", () => {
    expect(principalLabel({displayName: "Ada Lovelace", principalId: "service:key_1"}, "member_2"))
      .toBe("Ada Lovelace");
  });

  test("an unnamed principal is named by its credential kind, never as unknown", () => {
    expect(principalName(unnamed("local-api-token"))).toBe("Local API token");
    expect(principalName(unnamed("service:key_0f3c"))).toBe("API key");
    expect(principalName(unnamed("member_6b1d2e9a-77aa-4c1e-9d0e-123456789abc")))
      .toBe("Member 6b1d2e9a");
    expect(principalName(unnamed("external|auth0|42"))).toBe("external|auth0|42");
  });

  test("avatar initials come from the readable name", () => {
    expect(principalInitials({displayName: "Ada Lovelace", principalId: "member_1"})).toBe("AL");
    expect(principalInitials(unnamed("local-api-token"))).toBe("LA");
    expect(principalInitials(unnamed("service:key_1"))).toBe("AK");
  });
});
