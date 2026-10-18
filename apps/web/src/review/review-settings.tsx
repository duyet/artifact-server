import {type Project, type Session} from "@/api/client";
import {StatePanel} from "@/components/product";
import {buttonVariants, ButtonLink} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import {type SettingsRoute} from "./review-routes.ts";
import {ApiKeysScreen} from "./settings-api-keys.tsx";
import {McpScreen} from "./settings-mcp.tsx";
import {MembersScreen} from "./settings-members.tsx";
import {SettingsProject, SettingsProjects} from "./settings-projects.tsx";
import {PublicLinksScreen} from "./settings-public-links.tsx";

interface ReviewSettingsProps {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
  readonly session: Session;
}

/** Render project and installation administration inside the application shell. */
export function ReviewSettings({
  onProjectsChanged,
  projects,
  route,
  session,
}: ReviewSettingsProps) {
  const principal = session.principal;
  const directHuman = principal.kind === "human"
    && principal.authorizedByPrincipalId === null;
  const canManageProjects = directHuman
    || principal.capabilities.includes("project:manage");
  const administrator = directHuman
    && principal.membershipRole === "administrator";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <nav aria-label="Settings" className="flex flex-wrap gap-1">
        {canManageProjects ? (
          <SettingsLink active={route.kind === "projects" || route.kind === "project"} href="/review/settings/projects">
            Projects
          </SettingsLink>
        ) : null}
        <SettingsLink active={route.kind === "mcp"} href="/review/settings/mcp">
          MCP
        </SettingsLink>
        {administrator ? (
          <>
            <SettingsLink active={route.kind === "members"} href="/review/settings/members">Members</SettingsLink>
            <SettingsLink active={route.kind === "apiKeys"} href="/review/settings/api-keys">API keys</SettingsLink>
            <SettingsLink active={route.kind === "publicLinks"} href="/review/settings/public-links">Public links</SettingsLink>
          </>
        ) : null}
      </nav>
      <SettingsContent
        administrator={administrator}
        canManageProjects={canManageProjects}
        onProjectsChanged={onProjectsChanged}
        projects={projects}
        route={route}
      />
    </div>
  );
}

function SettingsContent({
  administrator,
  canManageProjects,
  onProjectsChanged,
  projects,
  route,
}: {
  readonly administrator: boolean;
  readonly canManageProjects: boolean;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
}) {
  if (route.kind === "notFound") {
    return (
      <StatePanel
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            View settings
          </ButtonLink>
        )}
        description="This Artifact Server settings route does not exist."
        title="Page not found"
      />
    );
  }
  if (route.kind === "projects" || route.kind === "project") {
    if (!canManageProjects) return <ProjectPermissionRequired />;
    if (route.kind === "projects") {
      return (
        <SettingsProjects
          canManage={canManageProjects}
          onProjectsChanged={onProjectsChanged}
          projects={projects}
        />
      );
    }
    return (
      <SettingsProject
        canManage={canManageProjects}
        onProjectsChanged={onProjectsChanged}
        projectId={route.projectId}
        projects={projects}
      />
    );
  }
  if (route.kind === "mcp") return <McpScreen administrator={administrator} />;
  if (!administrator) return <AdministratorPermissionRequired />;
  switch (route.kind) {
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
  }
  return <AdministratorPermissionRequired />;
}

function SettingsLink({
  active,
  children,
  href,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly href: string;
}) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={cn(buttonVariants({size: "sm", variant: "ghost"}), active && "bg-muted")}
      data-active={active}
      href={href}
    >
      {children}
    </a>
  );
}

function ProjectPermissionRequired() {
  return (
    <StatePanel
      description="This account cannot manage projects."
      title="Project permission required"
    />
  );
}

function AdministratorPermissionRequired() {
  return (
    <StatePanel
      description="Only an installation administrator can manage members, API keys, and public links."
      title="Administrator permission required"
    />
  );
}
