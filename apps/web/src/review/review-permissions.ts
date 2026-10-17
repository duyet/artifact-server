import type {Project, Session} from "@/api/client";

/** What the signed-in principal may do in the selected project. */
export interface ReviewPermissions {
  readonly canComment: boolean;
  readonly canDeleteAnyComment: boolean;
  readonly canManageArtifacts: boolean;
  readonly canManageProjects: boolean;
}

/**
 * A human signed in directly holds every project right; a delegated or
 * service principal holds only the capabilities it was granted. Nothing in an
 * archived project can change.
 */
export function reviewPermissions(session: Session, project: Project | null): ReviewPermissions {
  const principal = session.principal;
  const directHuman = principal.kind === "human" && principal.authorizedByPrincipalId === null;
  const writable = project?.archivedAt === null;
  return {
    canComment: writable && (directHuman || principal.capabilities.includes("comment:write")),
    canDeleteAnyComment: (directHuman && principal.membershipRole === "administrator")
      || principal.capabilities.includes("artifact:manage:any"),
    canManageArtifacts: writable
      && (directHuman || principal.capabilities.includes("artifact:manage:any")),
    canManageProjects: directHuman || principal.capabilities.includes("project:manage"),
  };
}
