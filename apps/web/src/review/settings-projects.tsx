import {useEffect, useState} from "react";
import {toast} from "sonner";

import {api, type Project} from "@/api/client";
import {ButtonSpinner, ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {Button, ButtonLink} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {Field, FieldError, FieldGroup, FieldLabel} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {formatTimestamp} from "@/lib/presentation";
import {projectSettingsHref} from "./review-routes.ts";

interface ProjectSettingsSharedProps {
  readonly canManage: boolean;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
}

/** List every project and provide the canonical project creation surface. */
export function SettingsProjects({
  canManage,
  onProjectsChanged,
  projects,
}: ProjectSettingsSharedProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const orderedProjects = [...projects].toSorted((left, right) => {
    if (left.archivedAt === null && right.archivedAt !== null) return -1;
    if (left.archivedAt !== null && right.archivedAt === null) return 1;
    return left.name.localeCompare(right.name);
  });

  const createProject = async (): Promise<void> => {
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      const created = await api.createProject(name.trim());
      await onProjectsChanged();
      window.location.assign(projectSettingsHref(created.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project creation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={canManage ? (
          <Dialog
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open && !pending) {
                setError(null);
                setName("");
              }
            }}
            open={createOpen}
          >
            <DialogTrigger render={<Button type="button" />}>New project</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New project</DialogTitle>
                <DialogDescription>
                  Create a place for related artifacts. Every installation member can use it.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field data-invalid={error === null ? undefined : true}>
                  <FieldLabel className="sr-only" htmlFor="settings-project-name">Project name</FieldLabel>
                  <Input
                    aria-invalid={error === null ? undefined : true}
                    autoFocus
                    id="settings-project-name"
                    maxLength={120}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Project name"
                    value={name}
                  />
                  {error === null ? null : <FieldError>{error.message}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button disabled={pending} onClick={() => setCreateOpen(false)} type="button" variant="outline">
                  Cancel
                </Button>
                <Button disabled={pending || name.trim() === ""} onClick={() => void createProject()} type="button">
                  {pending ? <ButtonSpinner /> : null}
                  {pending ? "Creating…" : "Create project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : undefined}
        description="Create projects, open their artifacts, or manage their lifecycle."
        title="Projects"
      />

      {orderedProjects.length === 0 ? (
        <StatePanel
          description="Create a project to begin organizing artifacts in this installation."
          title="No projects"
        />
      ) : (
        <Card>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Project</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="pr-4 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderedProjects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="pl-4">
                      <a className="font-medium hover:underline" href={projectSettingsHref(project.id)}>
                        {project.name}
                      </a>
                      <code className="block max-w-80 truncate font-mono text-xs text-muted-foreground" title={project.id}>
                        {project.id}
                      </code>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={project.archivedAt === null ? "primary" : "neutral"}>
                        {project.archivedAt === null ? "Active" : "Archived"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(project.createdAt)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex justify-end gap-2">
                        <ButtonLink
                          href={`/review?project=${encodeURIComponent(project.id)}`}
                          size="sm"
                          variant="outline"
                        >
                          Open artifacts
                        </ButtonLink>
                        <ButtonLink href={projectSettingsHref(project.id)} size="sm">
                          Settings
                        </ButtonLink>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Manage one project's identity and lifecycle. */
export function SettingsProject({
  canManage,
  onProjectsChanged,
  projectId,
  projects,
}: ProjectSettingsSharedProps & {readonly projectId: string}) {
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const [name, setName] = useState(project?.name ?? "");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setName(project?.name ?? "");
  }, [project?.name]);

  if (project === null) {
    return (
      <StatePanel
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            View projects
          </ButtonLink>
        )}
        description="The project named by this settings URL is unavailable."
        title="Project not found"
      />
    );
  }

  const rename = async (): Promise<void> => {
    if (pending || name.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      await api.renameProject(project.id, name.trim());
      await onProjectsChanged();
      toast.success("Project renamed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project rename failed."));
    } finally {
      setPending(false);
    }
  };
  const changeArchiveState = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      if (project.archivedAt === null) {
        await api.archiveProject(project.id);
      } else {
        await api.unarchiveProject(project.id);
      }
      await onProjectsChanged();
      setArchiveOpen(false);
      toast.success(project.archivedAt === null ? "Project archived." : "Project unarchived.");
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project update failed."));
    } finally {
      setPending(false);
    }
  };
  const archived = project.archivedAt !== null;
  const unchangedName = name.trim() === project.name;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={(
          <ButtonLink
            href={`/review?project=${encodeURIComponent(project.id)}`}
            variant="outline"
          >
            Open artifacts
          </ButtonLink>
        )}
        description={archived
          ? "This project is archived. Existing artifacts and immutable versions remain readable."
          : "Manage this project's name, lifecycle, and optional history."}
        title={project.name}
      />
      {error === null ? null : <ErrorPanel error={error} />}

      <Card role="region" aria-labelledby="project-identity-heading">
        <CardHeader>
          <CardTitle aria-level={2} id="project-identity-heading" role="heading">Project identity</CardTitle>
          <CardDescription>Renaming changes the label, not the stable project ID.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            id="settings-rename-project-form"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <FieldGroup>
              <Field className="max-w-xl">
                <FieldLabel htmlFor="settings-rename-project">Project name</FieldLabel>
                <Input
                  disabled={!canManage || pending}
                  id="settings-rename-project"
                  maxLength={120}
                  onChange={(event) => setName(event.currentTarget.value)}
                  value={name}
                />
              </Field>
            </FieldGroup>
          </form>
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-4">
            <dt className="text-muted-foreground">Project ID</dt>
            <dd><code className="font-mono text-xs break-all">{project.id}</code></dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatTimestamp(project.createdAt)}</dd>
          </dl>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={!canManage || pending || name.trim() === "" || unchangedName}
            form="settings-rename-project-form"
            type="submit"
          >
            {pending ? <ButtonSpinner /> : null}
            {pending ? "Saving…" : "Save name"}
          </Button>
        </CardFooter>
      </Card>

      <Card role="region" aria-labelledby="project-lifecycle-heading" className="ring-destructive/30">
        <CardHeader>
          <CardTitle aria-level={2} id="project-lifecycle-heading" role="heading">Project lifecycle</CardTitle>
          <CardDescription>
            {archived
              ? "Unarchive this project to accept new artifacts and versions again."
              : "Archiving stops new artifacts and versions. Existing reads, links, and immutable history remain."}
          </CardDescription>
        </CardHeader>
        {canManage ? (
          <CardContent>
            <AlertDialog onOpenChange={setArchiveOpen} open={archiveOpen}>
              <AlertDialogTrigger
                render={<Button type="button" variant={archived ? "outline" : "destructive"} />}
              >
                {archived ? "Unarchive project" : "Archive project"}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{archived ? "Unarchive project?" : "Archive project?"}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {archived
                      ? "This project will accept new artifacts and versions again."
                      : "New publication stops. Saved artifacts, links, and immutable versions remain readable."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={pending}
                    onClick={() => void changeArchiveState()}
                    variant={archived ? "default" : "destructive"}
                  >
                    {pending ? <ButtonSpinner /> : null}
                    {pending ? "Working…" : archived ? "Unarchive project" : "Archive project"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
