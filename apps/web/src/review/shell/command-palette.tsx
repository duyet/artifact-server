import type {ComponentType} from "react";
import {
  IconChartBar,
  IconCopy,
  IconCursorText,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconPencil,
  IconPlugConnected,
  IconSettings,
  IconShare,
} from "@tabler/icons-react";
import {useEffect, useState} from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {analyticsPath, artifactsPath, mcpSettingsPath, settingsPath, withProject} from "../review-routes.ts";
import {useArtifactSearch} from "./use-artifact-search.ts";

export type ArtifactCommandId = "duplicate" | "edit" | "rename" | "share";

/** What the open artifact can do from the palette; absent while none is open. */
export interface ArtifactCommands {
  /** The commands the signed-in principal may run on this artifact. */
  readonly available: readonly ArtifactCommandId[];
  readonly run: (command: ArtifactCommandId) => void;
}

const artifactCommandList: readonly {
  readonly icon: ComponentType;
  readonly id: ArtifactCommandId;
  readonly label: string;
}[] = [
  {icon: IconCursorText, id: "rename", label: "Rename"},
  {icon: IconPencil, id: "edit", label: "Edit file"},
  {icon: IconCopy, id: "duplicate", label: "Duplicate"},
  {icon: IconShare, id: "share", label: "Share"},
];

function pageList(projectId: string): readonly {
  readonly href: string;
  readonly icon: ComponentType;
  readonly label: string;
}[] {
  return [
    {href: withProject(artifactsPath, projectId), icon: IconLayoutGrid, label: "Artifacts"},
    {href: withProject(analyticsPath, projectId), icon: IconChartBar, label: "Analytics"},
    {href: `${settingsPath}/projects`, icon: IconSettings, label: "Settings"},
    {href: mcpSettingsPath, icon: IconPlugConnected, label: "Settings › MCP"},
    {href: `${settingsPath}/api-keys`, icon: IconKey, label: "Settings › API keys"},
  ];
}

/** Every word typed appears somewhere in the label, in any order. */
function matches(label: string, query: string): boolean {
  const haystack = label.toLowerCase();
  return query.toLowerCase().split(/\s+/u).every((word) => haystack.includes(word));
}

/**
 * Search artifacts, jump to a page, or act on the open artifact. Artifacts
 * are searched on the server; pages and actions are filtered here.
 */
export function CommandPalette({
  artifactCommands,
  onNavigate,
  onOpenArtifact,
  onOpenChange,
  open,
  projectId,
}: {
  readonly artifactCommands: ArtifactCommands | null;
  readonly onNavigate: (href: string) => void;
  readonly onOpenArtifact: (artifactId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly projectId: string;
}) {
  const [query, setQuery] = useState("");
  const search = useArtifactSearch(projectId, query, open);
  const trimmed = query.trim();
  const pages = pageList(projectId).filter(({label}) => matches(label, trimmed));
  const commands = artifactCommandList.filter(({id, label}) =>
    artifactCommands?.available.includes(id) === true && matches(label, trimmed));

  // Results arrive after typing, so cmdk's own pick would stay on a page
  // below them. Keep the top result selected so Enter always opens it.
  const topResult = search.items[0] !== undefined && !search.stale
    ? `artifact:${search.items[0].artifact.id}`
    : pages[0] !== undefined
      ? `page:${pages[0].href}`
      : commands[0] !== undefined ? `action:${commands[0].id}` : "";
  const [selected, setSelected] = useState("");
  useEffect(() => setSelected(topResult), [query, topResult]);

  const setOpen = (next: boolean): void => {
    if (!next) setQuery("");
    onOpenChange(next);
  };
  const choose = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <CommandDialog
      className="sm:max-w-lg"
      description="Search artifacts, jump to a page, or act on the open artifact."
      onOpenChange={setOpen}
      open={open}
      title="Command palette"
    >
      {/* The server ranks artifacts, so cmdk must not filter or reorder them. */}
      <Command onValueChange={setSelected} shouldFilter={false} value={selected}>
        <CommandInput onValueChange={setQuery} placeholder="Search artifacts, pages, and actions…" value={query} />
        <CommandList>
          <CommandEmpty>{search.stale ? "Searching…" : "No results found."}</CommandEmpty>
          {search.error === null ? null : (
            <p className="px-3 py-2 text-sm text-destructive" role="alert">
              Artifact search failed: {search.error.message}
            </p>
          )}
          {search.items.length === 0 ? null : (
            <CommandGroup heading="Artifacts">
              {search.items.map(({artifact}) => (
                <CommandItem
                  disabled={search.stale}
                  key={artifact.id}
                  onSelect={() => choose(() => onOpenArtifact(artifact.id))}
                  value={`artifact:${artifact.id}`}
                >
                  <IconFileText />
                  <span className="truncate">{artifact.name}</span>
                  {artifact.path === null || artifact.path === "" ? null : (
                    <span className="truncate text-xs text-muted-foreground">{artifact.path}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {pages.length === 0 ? null : (
            <CommandGroup heading="Pages">
              {pages.map(({href, icon: Icon, label}) => (
                <CommandItem key={href} onSelect={() => choose(() => onNavigate(href))} value={`page:${href}`}>
                  <Icon />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {commands.length === 0 ? null : (
            <CommandGroup heading="Actions">
              {commands.map(({icon: Icon, id, label}) => (
                <CommandItem key={id} onSelect={() => choose(() => artifactCommands?.run(id))} value={`action:${id}`}>
                  <Icon />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
