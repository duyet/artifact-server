import type {ComponentType} from "react";
import {IconBook, IconBrandGithub, IconExternalLink, IconHome} from "@tabler/icons-react";

import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle} from "@/components/ui/item";
import artifactServerAnimationUrl from "../assets/artifact-server.svg";
import {AgentLogos} from "../share/agent-logos.tsx";

const resources: readonly {
  readonly description: string;
  readonly href: string;
  readonly icon: ComponentType;
  readonly title: string;
}[] = [
  {description: "Source and releases", href: "https://github.com/plannotator/artifact-server", icon: IconBrandGithub, title: "GitHub"},
  {description: "Product overview", href: "https://artifactserver.com/", icon: IconHome, title: "Homepage"},
  {description: "Install and deploy", href: "https://artifactserver.com/docs/", icon: IconBook, title: "Docs"},
];

/** The product's home card: its mark and where to learn more. */
export function HomeDialog({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="sr-only">Artifact Server home</DialogTitle>
        <img alt="" aria-hidden="true" className="mx-auto h-40 w-auto" src={artifactServerAnimationUrl} />
        <nav aria-label="Artifact Server resources">
          <ItemGroup className="gap-1">
            {resources.map(({description, href, icon: Icon, title}) => (
              <Item key={href} render={<a href={href} rel="noreferrer" target="_blank" />} size="sm" variant="outline">
                <ItemMedia variant="icon"><Icon /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{title}</ItemTitle>
                  <ItemDescription>{description}</ItemDescription>
                </ItemContent>
                <ItemActions><IconExternalLink className="size-4 text-muted-foreground" /></ItemActions>
              </Item>
            ))}
            {/* TODO(open-source-launch): publish the dedicated agent-connection guide at this canonical route. */}
            <Item
              render={<a href="https://artifactserver.com/docs/connect-agents/" rel="noreferrer" target="_blank" />}
              size="sm"
              variant="outline"
            >
              <ItemMedia variant="icon"><AgentLogos className="[&_[data-slot=agent-logo]]:size-3" /></ItemMedia>
              <ItemContent>
                <ItemTitle>Connect agents</ItemTitle>
                <ItemDescription>MCP and client setup</ItemDescription>
              </ItemContent>
              <ItemActions><IconExternalLink className="size-4 text-muted-foreground" /></ItemActions>
            </Item>
          </ItemGroup>
        </nav>
      </DialogContent>
    </Dialog>
  );
}
