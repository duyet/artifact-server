import {IconChevronRight, IconFileText, IconFolder} from "@tabler/icons-react";

import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {ancestorFolderPaths, buildPathTree, type PathTreeNode} from "@/lib/path-tree";
import type {CatalogItem} from "../catalog/use-artifact-catalog.ts";
import {reviewHref} from "../review-location.ts";

/**
 * An artifact sits under folders named by its readable path. One without a
 * path is a top-level row named by the artifact itself.
 */
function segmentsOf(item: CatalogItem): readonly string[] {
  const path = item.artifact.path;
  return path === null || path === "" ? [item.artifact.name] : path.split("/");
}

/**
 * The project's artifacts as a file tree, linking each to its viewer. Search
 * results open every folder so each match is visible.
 */
export function ArtifactTree({
  filtered,
  items,
  loading,
  projectId,
  selectedArtifactId,
}: {
  readonly filtered: boolean;
  readonly items: readonly CatalogItem[];
  readonly loading: boolean;
  readonly projectId: string;
  readonly selectedArtifactId: string | null;
}) {
  if (loading && items.length === 0) {
    return (
      <SidebarMenu>
        {[0, 1, 2, 3].map((row) => (
          <SidebarMenuItem key={row}><SidebarMenuSkeleton showIcon /></SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }
  if (filtered && items.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching artifacts</p>;
  }
  const tree = buildPathTree(items, segmentsOf);
  const openFolders = new Set(filtered
    ? items.flatMap(({artifact}) => artifact.path === null ? [] : ancestorFolderPaths(artifact.path))
    : ancestorFolderPaths(items.find(({artifact}) => artifact.id === selectedArtifactId)?.artifact.path ?? ""));
  return (
    // Folders read `openFolders` only when they mount, so entering or leaving
    // search remounts the tree.
    <SidebarMenu key={filtered ? "search" : "browse"}>
      {tree.map((node) => (
        <TreeNode
          key={node.kind === "leaf" ? node.item.artifact.id : `folder:${node.path}`}
          node={node}
          openFolders={openFolders}
          projectId={projectId}
          selectedArtifactId={selectedArtifactId}
        />
      ))}
    </SidebarMenu>
  );
}

function TreeNode({
  node,
  openFolders,
  projectId,
  selectedArtifactId,
}: {
  readonly node: PathTreeNode<CatalogItem>;
  readonly openFolders: ReadonlySet<string>;
  readonly projectId: string;
  readonly selectedArtifactId: string | null;
}) {
  if (node.kind === "leaf") {
    const {artifact} = node.item;
    const selected = artifact.id === selectedArtifactId;
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-current={selected ? "page" : undefined}
          isActive={selected}
          render={(
            <a
              href={reviewHref({artifactId: artifact.id, path: null, projectId, versionId: null, view: null})}
              title={artifact.path ?? artifact.name}
            />
          )}
        >
          <IconFileText />
          <span>{artifact.name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <Collapsible
        className="group/collapsible [&[data-open]>button>svg:first-child]:rotate-90"
        defaultOpen={openFolders.has(node.path)}
      >
        <CollapsibleTrigger render={<SidebarMenuButton />}>
          <IconChevronRight className="transition-transform" />
          <IconFolder />
          <span>{node.name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            {node.children.map((child) => (
              <TreeNode
                key={child.kind === "leaf" ? child.item.artifact.id : `folder:${child.path}`}
                node={child}
                openFolders={openFolders}
                projectId={projectId}
                selectedArtifactId={selectedArtifactId}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
