import {Fragment, useCallback, useEffect, useRef, useState} from "react";

import type {Project, Session} from "@/api/client";
import {AnalyticsPage} from "@/analytics/analytics-page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {Separator} from "@/components/ui/separator";
import {SidebarInset, SidebarProvider, SidebarTrigger, useSidebar} from "@/components/ui/sidebar";
import {Toaster} from "@/components/ui/sonner";
import {TooltipProvider} from "@/components/ui/tooltip";
import {ArtifactsPage} from "./catalog/artifacts-page.tsx";
import {useArtifactCatalog} from "./catalog/use-artifact-catalog.ts";
import {readReviewLocation, reviewHref, type ReviewLocation} from "./review-location.ts";
import {reviewPermissions} from "./review-permissions.ts";
import {parseReviewRoute, withProject} from "./review-routes.ts";
import {ReviewSettings} from "./review-settings.tsx";
import {KeyboardShortcutsDialog, reviewShortcutBlocked} from "./review-shortcuts.tsx";
import {AppSidebar} from "./shell/app-sidebar.tsx";
import {HomeDialog} from "./shell/home-dialog.tsx";
import {useReviewNavigation, useSameAppLinks, type NavigationMode} from "./use-review-navigation.ts";
import {ArtifactViewer} from "./viewer/artifact-viewer.tsx";

const settingsTitles = {
  apiKeys: "API keys",
  mcp: "MCP",
  members: "Members",
  notFound: "Not found",
  project: "Project",
  projects: "Projects",
  publicLinks: "Public links",
} as const;

/** The signed-in application: sidebar, routing, and every page. */
export function ReviewShell({
  onCreateProject,
  onProjectsChanged,
  onThemeChange,
  projects,
  session,
  theme,
}: {
  readonly onCreateProject: (name: string) => Promise<Project>;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}) {
  const {navigate, url} = useReviewNavigation();
  useSameAppLinks(navigate);
  const route = parseReviewRoute(url.pathname);
  const location = readReviewLocation(url.search);
  // Settings URLs name no project, so the sidebar keeps the one last viewed.
  const lastProjectIdRef = useRef<string | null>(null);
  if (location.projectId !== null) lastProjectIdRef.current = location.projectId;
  const projectId = location.projectId
    ?? lastProjectIdRef.current
    ?? projects.find((project) => project.archivedAt === null)?.id
    ?? projects[0]?.id
    ?? "";
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const permissions = reviewPermissions(session, project);
  const catalog = useArtifactCatalog(projectId);
  const [homeOpen, setHomeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const focus = route.kind === "artifacts" && location.artifactId !== null && location.view === "focus";

  // Every artifacts and analytics URL names its project, so a copied link
  // keeps pointing at the same project after the default changes.
  useEffect(() => {
    if (route.kind !== "settings" && location.projectId === null && projectId !== "") {
      navigate(route.kind === "analytics"
        ? withProject(url.pathname, projectId)
        : reviewHref({...location, projectId}), "replace");
    }
  }, [location, navigate, projectId, route.kind, url.pathname]);

  const go = useCallback((patch: Partial<ReviewLocation>, mode: NavigationMode): void => {
    navigate(reviewHref({...readReviewLocation(window.location.search), projectId, ...patch}), mode);
  }, [navigate, projectId]);

  const openArtifact = useCallback((artifactId: string, versionId: string | null): void => {
    go({artifactId, path: null, versionId, view: null}, "push");
  }, [go]);

  const selectProject = (nextProjectId: string): void => {
    if (route.kind === "settings") {
      navigate(withProject("/review", nextProjectId));
    } else if (route.kind === "analytics") {
      navigate(withProject(url.pathname, nextProjectId));
    } else {
      navigate(reviewHref({artifactId: null, path: null, projectId: nextProjectId, versionId: null, view: null}));
    }
  };

  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh overflow-hidden">
        <SidebarShortcut disabled={focus} />
        <AppSidebar
          canManageProjects={permissions.canManageProjects}
          catalog={catalog}
          onCreateProject={onCreateProject}
          onOpenHome={() => setHomeOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onSelectProject={selectProject}
          onThemeChange={onThemeChange}
          projectId={projectId}
          projects={projects}
          route={route}
          selectedArtifactId={route.kind === "artifacts" ? location.artifactId : null}
          session={session}
          theme={theme}
        />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          {route.kind === "artifacts" && location.artifactId !== null ? (
            <ArtifactViewer
              artifactId={location.artifactId}
              focus={focus}
              go={go}
              key={location.artifactId}
              navItems={catalog.items}
              onArtifactChanged={catalog.updateArtifact}
              onArtifactDeleted={(artifactId) => {
                catalog.removeArtifact(artifactId);
                go({artifactId: null, path: null, versionId: null, view: null}, "push");
              }}
              onCatalogStale={() => void catalog.refresh()}
              path={location.path}
              permissions={permissions}
              projectId={projectId}
              session={session}
              theme={theme}
              versionId={location.versionId}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <PageHeader
                crumbs={route.kind === "artifacts"
                  ? ["Artifacts"]
                  : route.kind === "analytics"
                    ? ["Analytics"]
                    : ["Settings", settingsTitles[route.settings.kind]]}
                projectName={route.kind === "settings" ? null : project?.name ?? null}
              />
              <div className="min-h-0 flex-1 overflow-y-auto" id="main-content">
                {route.kind === "artifacts" ? (
                  <ArtifactsPage
                    catalog={catalog}
                    onCatalogStale={() => void catalog.refresh()}
                    onOpenArtifact={openArtifact}
                    permissions={permissions}
                    project={project}
                    projectId={projectId}
                    session={session}
                  />
                ) : route.kind === "analytics" ? (
                  <AnalyticsPage key={projectId} projectId={projectId} />
                ) : (
                  <ReviewSettings
                    onProjectsChanged={onProjectsChanged}
                    projects={projects}
                    route={route.settings}
                    session={session}
                  />
                )}
              </div>
            </div>
          )}
        </SidebarInset>
      </SidebarProvider>
      <HomeDialog onOpenChange={setHomeOpen} open={homeOpen} />
      <KeyboardShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
      <Toaster position="bottom-right" theme={theme === "moon" ? "dark" : "light"} />
    </TooltipProvider>
  );
}

/** "[" shows or hides the sidebar everywhere except full screen. */
function SidebarShortcut({disabled}: {readonly disabled: boolean}) {
  const {toggleSidebar} = useSidebar();
  useEffect(() => {
    if (disabled) return undefined;
    const toggle = (event: KeyboardEvent): void => {
      if (event.key !== "[" || reviewShortcutBlocked(event)) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [disabled, toggleSidebar]);
  return null;
}

function PageHeader({
  crumbs,
  projectName,
}: {
  readonly crumbs: readonly string[];
  readonly projectName: string | null;
}) {
  const trail = projectName === null ? crumbs : [projectName, ...crumbs];
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <SidebarTrigger aria-keyshortcuts="[" />
      <Separator className="mr-1 data-vertical:h-4 data-vertical:self-center" orientation="vertical" />
      <Breadcrumb>
        <BreadcrumbList>
          {trail.map((crumb, index) => index === trail.length - 1 ? (
            <BreadcrumbItem key={`${index}-${crumb}`}>
              <BreadcrumbPage>{crumb}</BreadcrumbPage>
            </BreadcrumbItem>
          ) : (
            <Fragment key={`${index}-${crumb}`}>
              <BreadcrumbItem className="hidden md:inline-flex">{crumb}</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
}
