/** Who can find and open an artifact. */
export type Visibility = "private" | "public" | "unlisted";

/** The stored fields visibility is derived from. */
export interface VisibilityFields {
  readonly accessSetting: "account_required" | "public_link";
  readonly tags: readonly string[];
}

/** One write that moves an artifact toward a visibility. */
export type VisibilityStep =
  | {readonly accessSetting: VisibilityFields["accessSetting"]; readonly kind: "access"}
  | {readonly kind: "tags"; readonly tags: readonly string[]};

/** The tag that keeps a public artifact out of the public tree. */
export const unlistedTag = "unlisted";

/**
 * Private needs an account whatever the tags say. The unlisted tag keeps a
 * public link out of the public tree.
 */
export function visibilityOf(
  accessSetting: VisibilityFields["accessSetting"],
  tags: readonly string[],
): Visibility {
  if (accessSetting === "account_required") return "private";
  return tags.includes(unlistedTag) ? "unlisted" : "public";
}

/**
 * The writes that move `current` to `target`, only those whose value differs.
 * Going private changes access first and never touches tags. Going public or
 * unlisted sets the tag before opening access, so no step in between is more
 * exposed than both the start and the target.
 */
export function visibilitySteps(
  current: VisibilityFields,
  target: Visibility,
): readonly VisibilityStep[] {
  if (target === "private") {
    return current.accessSetting === "account_required"
      ? []
      : [{accessSetting: "account_required", kind: "access"}];
  }
  const hidden = current.tags.includes(unlistedTag);
  const tags: VisibilityStep[] = target === "unlisted" && !hidden
    ? [{kind: "tags", tags: [...current.tags, unlistedTag].toSorted()}]
    : target === "public" && hidden
      ? [{kind: "tags", tags: current.tags.filter((tag) => tag !== unlistedTag)}]
      : [];
  const access: VisibilityStep[] = current.accessSetting === "public_link"
    ? []
    : [{accessSetting: "public_link", kind: "access"}];
  return [...tags, ...access];
}
