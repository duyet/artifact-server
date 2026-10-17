import {IconFilter} from "@tabler/icons-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type CatalogCommentFilter = "all" | "with" | "without";

const commentFilters = [
  {label: "All artifacts", value: "all"},
  {label: "With comments", value: "with"},
  {label: "No comments", value: "without"},
] as const satisfies readonly {readonly label: string; readonly value: CatalogCommentFilter}[];

function filterLabel(commentFilter: CatalogCommentFilter, tagFilters: readonly string[]): string {
  const activeCount = Number(commentFilter !== "all") + tagFilters.length;
  if (commentFilter === "all" && tagFilters.length === 1) return tagFilters[0] ?? "1 tag";
  if (commentFilter === "all" && tagFilters.length > 1) return `${tagFilters.length} tags`;
  if (tagFilters.length === 0) {
    return commentFilters.find((filter) => filter.value === commentFilter)?.label ?? "All artifacts";
  }
  return `${activeCount} filters`;
}

/** Narrow the catalog by comment presence and by any of its known tags. */
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
  const activeCount = Number(commentFilter !== "all") + tagFilters.length;
  const tags = [...new Set([...knownTags, ...tagFilters])].toSorted();
  const toggleTag = (tag: string, checked: boolean): void => {
    onTagFiltersChange(checked
      ? [...tagFilters, tag].toSorted()
      : tagFilters.filter((selected) => selected !== tag));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            aria-label={`Filter artifacts. ${activeCount === 0 ? "No filters applied" : `${activeCount} applied`}.`}
            size="sm"
            variant="outline"
          />
        )}
      >
        <IconFilter data-icon="inline-start" />
        <span className="max-w-32 truncate">{filterLabel(commentFilter, tagFilters)}</span>
        {activeCount === 0 ? null : <Badge variant="secondary">{activeCount}</Badge>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Comments</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value: CatalogCommentFilter) => onCommentFilterChange(value)}
            value={commentFilter}
          >
            {commentFilters.map((filter) => (
              <DropdownMenuRadioItem key={filter.value} value={filter.value}>
                {filter.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Tags</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={tagFilters.length === 0}
            onCheckedChange={() => onTagFiltersChange([])}
          >
            Any tag
          </DropdownMenuCheckboxItem>
          {tags.length === 0 ? (
            <DropdownMenuItem disabled>No tags in the loaded catalog.</DropdownMenuItem>
          ) : tags.map((tag) => (
            <DropdownMenuCheckboxItem
              checked={tagFilters.includes(tag)}
              key={tag}
              onCheckedChange={(checked) => toggleTag(tag, checked)}
            >
              {tag}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {activeCount === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  onCommentFilterChange("all");
                  onTagFiltersChange([]);
                }}
              >
                Clear filters
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
