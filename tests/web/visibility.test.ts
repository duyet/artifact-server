import {describe, expect, test} from "vitest";

import {
  type Visibility,
  type VisibilityFields,
  visibilityOf,
  type VisibilityStep,
  visibilitySteps,
} from "../../apps/web/src/lib/visibility.js";

const states = {
  hiddenPrivate: {accessSetting: "account_required", tags: ["draft", "unlisted"]},
  private: {accessSetting: "account_required", tags: ["draft"]},
  public: {accessSetting: "public_link", tags: ["draft"]},
  unlisted: {accessSetting: "public_link", tags: ["draft", "unlisted"]},
} satisfies Record<string, VisibilityFields>;

const toPublic: VisibilityStep = {accessSetting: "public_link", kind: "access"};
const toPrivate: VisibilityStep = {accessSetting: "account_required", kind: "access"};
const hide: VisibilityStep = {kind: "tags", tags: ["draft", "unlisted"]};
const show: VisibilityStep = {kind: "tags", tags: ["draft"]};

/** Each start and target with the writes the rule calls for, in order. */
const expectedSteps: readonly (readonly [
  keyof typeof states,
  Visibility,
  readonly VisibilityStep[],
])[] = [
  ["private", "public", [toPublic]],
  ["private", "unlisted", [hide, toPublic]],
  ["private", "private", []],
  ["hiddenPrivate", "public", [show, toPublic]],
  ["hiddenPrivate", "unlisted", [toPublic]],
  ["hiddenPrivate", "private", []],
  ["public", "public", []],
  ["public", "unlisted", [hide]],
  ["public", "private", [toPrivate]],
  ["unlisted", "public", [show]],
  ["unlisted", "unlisted", []],
  ["unlisted", "private", [toPrivate]],
];

const exposure = {private: 0, unlisted: 1, public: 2} satisfies Record<Visibility, number>;

function apply(fields: VisibilityFields, step: VisibilityStep): VisibilityFields {
  return step.kind === "access"
    ? {...fields, accessSetting: step.accessSetting}
    : {...fields, tags: step.tags};
}

describe("artifact visibility", () => {
  test("private ignores tags, and the unlisted tag hides only a public link", () => {
    expect([
      visibilityOf("account_required", []),
      visibilityOf("account_required", ["unlisted"]),
      visibilityOf("account_required", ["draft", "unlisted"]),
      visibilityOf("public_link", []),
      visibilityOf("public_link", ["draft"]),
      visibilityOf("public_link", ["unlisted"]),
      visibilityOf("public_link", ["draft", "unlisted"]),
    ]).toEqual([
      "private",
      "private",
      "private",
      "public",
      "public",
      "unlisted",
      "unlisted",
    ]);
  });

  test("each start and target needs only the differing writes, private first by access and otherwise tags before access", () => {
    for (const [start, target, steps] of expectedSteps) {
      expect(visibilitySteps(states[start], target), `${start} to ${target}`)
        .toEqual(steps);
    }
  });

  test("applying the writes reaches the target and never passes a state more exposed than both ends", () => {
    for (const [start, target] of expectedSteps) {
      const ceiling = Math.max(
        exposure[visibilityOf(states[start].accessSetting, states[start].tags)],
        exposure[target],
      );
      let fields: VisibilityFields = states[start];
      for (const step of visibilitySteps(fields, target)) {
        fields = apply(fields, step);
        expect(
          exposure[visibilityOf(fields.accessSetting, fields.tags)],
          `${start} to ${target}`,
        ).toBeLessThanOrEqual(ceiling);
      }
      expect(visibilityOf(fields.accessSetting, fields.tags)).toBe(target);
    }
  });
});
