import {useEffect, useState} from "react";
import {IconChevronRight, IconFile, IconFolder, IconFolderOpen} from "@tabler/icons-react";

import type {ArtifactVersion} from "@/api/client";
import {Button} from "@/components/ui/button";
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import type {PathTreeNode} from "@/lib/path-tree";
import {formatBytes} from "@/lib/presentation";
import {InspectorSection, InspectorStack} from "./inspector-layout.tsx";
import {buildFileTree, foldersToReveal} from "./inspector-model.ts";

type ManifestEntry = ArtifactVersion["manifest"]["entries"][number];

export function FilesInspector({
  onSelect,
  selectedPath,
  version,
}: {
  readonly onSelect: (path: string) => void;
  readonly selectedPath: string;
  readonly version: ArtifactVersion;
}) {
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(
    () => foldersToReveal(selectedPath),
  );
  // A selection made elsewhere (URL, keyboard) must never hide inside a closed folder.
  useEffect(() => {
    setOpenFolders((current) => new Set([...current, ...foldersToReveal(selectedPath)]));
  }, [selectedPath]);

  const toggleFolder = (path: string, open: boolean): void => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  return (
    <InspectorStack>
      <InspectorSection count={version.manifest.entries.length} title="Manifest">
        <FileTreeLevel
          nodes={buildFileTree(version.manifest.entries)}
          onSelect={onSelect}
          onToggleFolder={toggleFolder}
          openFolders={openFolders}
          selectedPath={selectedPath}
        />
      </InspectorSection>
    </InspectorStack>
  );
}

function FileTreeLevel({
  nodes,
  onSelect,
  onToggleFolder,
  openFolders,
  selectedPath,
}: {
  readonly nodes: readonly PathTreeNode<ManifestEntry>[];
  readonly onSelect: (path: string) => void;
  readonly onToggleFolder: (path: string, open: boolean) => void;
  readonly openFolders: ReadonlySet<string>;
  readonly selectedPath: string;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => node.kind === "folder" ? (
        <li key={`folder:${node.path}`}>
          <Collapsible
            onOpenChange={(open) => onToggleFolder(node.path, open)}
            open={openFolders.has(node.path)}
          >
            <CollapsibleTrigger
              render={(
                <Button
                  className="w-full justify-start aria-expanded:bg-transparent aria-expanded:hover:bg-muted"
                  size="sm"
                  variant="ghost"
                />
              )}
            >
              <IconChevronRight
                className="transition-transform in-aria-expanded:rotate-90"
                data-icon="inline-start"
              />
              {openFolders.has(node.path)
                ? <IconFolderOpen data-icon="inline-start" />
                : <IconFolder data-icon="inline-start" />}
              <span className="truncate">{node.name}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-3.5 border-l border-border pl-1">
                <FileTreeLevel
                  nodes={node.children}
                  onSelect={onSelect}
                  onToggleFolder={onToggleFolder}
                  openFolders={openFolders}
                  selectedPath={selectedPath}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </li>
      ) : (
        <li key={`file:${node.path}`}>
          <FileTreeLeaf
            entry={node.item}
            name={node.name}
            onSelect={onSelect}
            selected={selectedPath === node.item.path}
          />
        </li>
      ))}
    </ul>
  );
}

function FileTreeLeaf({
  entry,
  name,
  onSelect,
  selected,
}: {
  readonly entry: ManifestEntry;
  readonly name: string;
  readonly onSelect: (path: string) => void;
  readonly selected: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            aria-current={selected ? "true" : undefined}
            className="w-full justify-start data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
            data-selected={selected}
            onClick={() => onSelect(entry.path)}
            size="sm"
            type="button"
            variant="ghost"
          />
        )}
      >
        <IconFile data-icon="inline-start" />
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
          {formatBytes(entry.size)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono">{entry.path}</span>
        {" · "}
        {entry.mediaType}
      </TooltipContent>
    </Tooltip>
  );
}
