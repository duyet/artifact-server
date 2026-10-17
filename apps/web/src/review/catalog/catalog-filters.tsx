import {IconCheck, IconFilter} from "@tabler/icons-react";
import {Popover} from "@base-ui/react/popover";

export type CatalogCommentFilter = "all" | "with" | "without";

export function CatalogFilters({
  commentFilter,
  knownTags,
  onCommentFilterChange,
  onTagFiltersChange,
  tagFilters,
}: {
  readonly commentFilter: CatalogCommentFilter;
  readonly knownTags: readonly string[];
  readonly onCommentFilterChange: (filter: CatalogCommentFilter) => void;
  readonly onTagFiltersChange: (tags: readonly string[]) => void;
  readonly tagFilters: readonly string[];
}) {
  const activeFilterCount = Number(commentFilter !== "all") + tagFilters.length;
  let triggerLabel = "All artifacts";
  if (commentFilter === "all" && tagFilters.length === 1) {
    triggerLabel = tagFilters[0] ?? "1 tag";
  } else if (commentFilter === "all" && tagFilters.length > 1) {
    triggerLabel = `${tagFilters.length} tags`;
  } else if (commentFilter === "with" && tagFilters.length === 0) {
    triggerLabel = "With comments";
  } else if (commentFilter === "without" && tagFilters.length === 0) {
    triggerLabel = "No comments";
  } else if (activeFilterCount > 0) {
    triggerLabel = `${activeFilterCount} filters`;
  }
  const tags = [...new Set([...knownTags, ...tagFilters])].toSorted();
  const toggleTag = (tag: string): void => {
    onTagFiltersChange(
      tagFilters.includes(tag)
        ? tagFilters.filter((selected) => selected !== tag)
        : [...tagFilters, tag].toSorted(),
    );
  };

  return (
    <Popover.Root>
      <Popover.Trigger
        render={(
          <button
            aria-label={`Filter artifacts. ${activeFilterCount === 0 ? "No filters applied" : `${activeFilterCount} applied`}.`}
            className="as-catalog-filter-trigger"
            type="button"
          />
        )}
      >
        <IconFilter aria-hidden="true" stroke={1.8} />
        <span>{triggerLabel}</span>
        {activeFilterCount === 0 ? null : (
          <span aria-hidden="true" className="as-catalog-filter-trigger__count">
            {activeFilterCount}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="start"
          className="as-catalog-filter-positioner"
          sideOffset={6}
        >
          <Popover.Popup aria-label="Filter artifacts" className="as-catalog-filter-popover">
            {activeFilterCount === 0 ? null : (
              <div className="as-catalog-filter-popover__actions">
                <button
                  className="as-catalog-filter-popover__clear"
                  onClick={() => {
                    onCommentFilterChange("all");
                    onTagFiltersChange([]);
                  }}
                  type="button"
                >
                  Clear filters
                </button>
              </div>
            )}
            <fieldset>
              <legend>Comments</legend>
              {([
                ["all", "All artifacts"],
                ["with", "With comments"],
                ["without", "No comments"],
              ] as const).map(([value, label]) => (
                <label className="as-catalog-filter-option" data-selected={commentFilter === value} key={value}>
                  <input
                    checked={commentFilter === value}
                    name="catalog-comment-filter"
                    onChange={() => onCommentFilterChange(value)}
                    type="radio"
                    value={value}
                  />
                  <span>{label}</span>
                  {commentFilter === value ? (
                    <IconCheck aria-hidden="true" stroke={2} />
                  ) : null}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Tags</legend>
              <button
                aria-pressed={tagFilters.length === 0}
                className="as-catalog-filter-option"
                data-selected={tagFilters.length === 0}
                onClick={() => onTagFiltersChange([])}
                type="button"
              >
                <span>Any tag</span>
                {tagFilters.length === 0 ? (
                  <IconCheck aria-hidden="true" stroke={2} />
                ) : null}
              </button>
              {tags.length === 0 ? (
                <p className="as-catalog-filter-popover__empty">No tags in the loaded catalog.</p>
              ) : tags.map((tag) => (
                <label className="as-catalog-filter-option" data-selected={tagFilters.includes(tag)} key={tag}>
                  <input
                    checked={tagFilters.includes(tag)}
                    name="catalog-tag-filter"
                    onChange={() => toggleTag(tag)}
                    type="checkbox"
                    value={tag}
                  />
                  <span>{tag}</span>
                  {tagFilters.includes(tag) ? (
                    <IconCheck aria-hidden="true" stroke={2} />
                  ) : null}
                </label>
              ))}
            </fieldset>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

