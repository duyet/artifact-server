import {
  IconChartBar,
  IconKeyboard,
  IconLayoutGrid,
  IconLogout,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSelector,
  IconSettings,
  IconSun,
} from "@tabler/icons-react";

import {api, type Project, type Session} from "@/api/client";
import {Avatar, AvatarFallback} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {ArtifactMark} from "../artifact-mark.tsx";
import type {ArtifactCatalog} from "../catalog/use-artifact-catalog.ts";
import {principalInitials} from "../principal-name.ts";
import {ReviewProjectPicker} from "../review-project-picker.tsx";
import {analyticsPath, artifactsPath, settingsPath, withProject, type ReviewRoute} from "../review-routes.ts";
import {ArtifactTree} from "./artifact-tree.tsx";

/** The review application's left rail: project, destinations, artifacts, and you. */
export function AppSidebar({
  canManageProjects,
  catalog,
  onCreateProject,
  onOpenHome,
  onOpenShortcuts,
  onSelectProject,
  onThemeChange,
  projectId,
  projects,
  route,
  selectedArtifactId,
  session,
  theme,
}: {
  readonly canManageProjects: boolean;
  readonly catalog: ArtifactCatalog;
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onOpenHome: () => void;
  readonly onOpenShortcuts: () => void;
  readonly onSelectProject: (projectId: string) => void;
  readonly onThemeChange: () => void;
  readonly projectId: string;
  readonly projects: readonly Project[];
  readonly route: ReviewRoute;
  readonly selectedArtifactId: string | null;
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}) {
  const navigation = [
    {href: withProject(artifactsPath, projectId), icon: IconLayoutGrid, kind: "artifacts", label: "Artifacts"},
    {href: withProject(analyticsPath, projectId), icon: IconChartBar, kind: "analytics", label: "Analytics"},
    {href: `${settingsPath}/projects`, icon: IconSettings, kind: "settings", label: "Settings"},
  ] as const;

  return (
    <Sidebar collapsible="offcanvas">
      <nav aria-label="Artifact catalog" className="contents">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1">
              <a
                aria-label="Artifact Server"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
                href={artifactsPath}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onOpenHome();
                }}
                title="Artifact Server"
              >
                <ArtifactMark className="size-4" />
              </a>
              <ReviewProjectPicker
                canCreate={canManageProjects}
                onCreate={onCreateProject}
                onSelect={onSelectProject}
                projects={projects}
                selectedProjectId={projectId}
              />
            </SidebarMenuItem>
          </SidebarMenu>
          <form className="relative" onSubmit={(event) => event.preventDefault()} role="search">
            <SidebarInput
              aria-label="Search artifacts"
              className="pl-8"
              onChange={(event) => catalog.setQuery(event.currentTarget.value)}
              placeholder="Search artifacts…"
              type="search"
              value={catalog.query}
            />
            <IconSearch className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
          </form>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.kind}>
                    <SidebarMenuButton
                      aria-current={route.kind === item.kind ? "page" : undefined}
                      isActive={route.kind === item.kind && (item.kind !== "artifacts" || selectedArtifactId === null)}
                      render={<a href={item.href} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.kind === "artifacts" && catalog.items.length > 0 ? (
                      <SidebarMenuBadge>{catalog.items.length}{catalog.nextCursor === null ? "" : "+"}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="min-h-0 flex-1">
            <SidebarGroupLabel>Files</SidebarGroupLabel>
            <SidebarGroupAction
              aria-label="Refresh artifacts"
              disabled={catalog.loading}
              onClick={() => void catalog.refresh()}
              title="Refresh artifacts"
            >
              <IconRefresh />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <ArtifactTree
                filtered={catalog.query.trim() !== ""}
                items={catalog.items}
                loading={catalog.loading}
                projectId={projectId}
                selectedArtifactId={selectedArtifactId}
              />
              {catalog.nextCursor === null ? null : (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton className="text-muted-foreground" disabled={catalog.loading} onClick={catalog.loadMore}>
                      <span>{catalog.loading ? "Loading…" : "Load more"}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <UserMenu
            onOpenShortcuts={onOpenShortcuts}
            onThemeChange={onThemeChange}
            session={session}
            theme={theme}
          />
        </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}

function UserMenu({
  onOpenShortcuts,
  onThemeChange,
  session,
  theme,
}: {
  readonly onOpenShortcuts: () => void;
  readonly onThemeChange: () => void;
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}) {
  const principal = session.principal;
  const identity = {displayName: principal.displayName ?? null, principalId: principal.id};
  const name = principal.displayName ?? (principal.kind === "service" ? "Service key" : "Signed in");
  const role = principal.membershipRole === "administrator" ? "Administrator" : "Member";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton aria-label={`Account: ${name}`} className="data-popup-open:bg-sidebar-accent" size="lg" />}
          >
            <Avatar className="rounded-lg">
              <AvatarFallback className="rounded-lg">{principalInitials(identity)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{role}</span>
            </span>
            <IconSelector className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onThemeChange}>
                {theme === "moon" ? <IconSun /> : <IconMoon />}
                {theme === "moon" ? "Use light theme" : "Use dark theme"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenShortcuts}>
                <IconKeyboard />
                Keyboard shortcuts
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href={`${settingsPath}/projects`} />}>
                <IconSettings />
                Open settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void api.logout().finally(() => window.location.assign("/review"))}>
                <IconLogout />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
