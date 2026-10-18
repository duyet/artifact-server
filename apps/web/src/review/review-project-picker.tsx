import {IconCheck, IconFolderCog, IconPlus, IconSelector, IconSettings} from "@tabler/icons-react";
import {type FormEvent, useMemo, useState} from "react";

import {type Project} from "@/api/client";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {Separator} from "@/components/ui/separator";
import {SidebarMenuButton} from "@/components/ui/sidebar";
import {projectSettingsHref} from "./review-routes.ts";

const projectActionClass = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent";

interface ReviewProjectPickerProps {
  readonly canCreate: boolean;
  readonly onCreate: (name: string) => Promise<Project>;
  readonly onSelect: (projectId: string) => void;
  readonly projects: readonly Project[];
  readonly selectedProjectId: string;
}

/** Switch project context and provide the review application's project-creation entry point. */
export function ReviewProjectPicker({
  canCreate,
  onCreate,
  onSelect,
  projects,
  selectedProjectId,
}: ReviewProjectPickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerScreen, setPickerScreen] = useState<"create" | "projects">("projects");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
    ?? null;
  const orderedProjects = useMemo(
    () => [...projects].toSorted((left, right) => {
      if (left.archivedAt === null && right.archivedAt !== null) return -1;
      if (left.archivedAt !== null && right.archivedAt === null) return 1;
      return left.name.localeCompare(right.name);
    }),
    [projects],
  );

  const chooseProject = (projectId: string): void => {
    setPickerOpen(false);
    onSelect(projectId);
  };
  const showCreateForm = (): void => {
    setError(null);
    setPickerScreen("create");
  };
  const changePickerOpen = (open: boolean): void => {
    if (!open && !creating) {
      setName("");
      setError(null);
      setPickerScreen("projects");
    }
    setPickerOpen(open);
  };
  const createProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "" || creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await onCreate(trimmedName);
      setPickerOpen(false);
      setPickerScreen("projects");
      setName("");
      onSelect(project.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Project creation failed."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Popover onOpenChange={changePickerOpen} open={pickerOpen}>
      <PopoverTrigger
        aria-label={`Current project: ${selectedProject?.name ?? "none"}`}
        render={<SidebarMenuButton className="data-popup-open:bg-sidebar-accent" size="lg" />}
      >
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate font-medium">{selectedProject?.name ?? "Select project"}</span>
          <span className="truncate text-xs text-muted-foreground">Project</span>
        </span>
        <IconSelector aria-hidden="true" className="ml-auto" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 gap-2 p-1"
        data-screen={pickerScreen}
        sideOffset={6}
      >
        {pickerScreen === "projects"
          ? (
            <>
              <PopoverTitle className="sr-only">Projects</PopoverTitle>
              <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Projects</p>
              <div aria-label="Projects" className="flex max-h-72 flex-col overflow-y-auto" role="listbox">
                {orderedProjects.map((project) => {
                  const selected = project.id === selectedProjectId;
                  return (
                    <button
                      aria-selected={selected}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                      key={project.id}
                      onClick={() => chooseProject(project.id)}
                      role="option"
                      type="button"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate">{project.name}</span>
                        {project.archivedAt === null
                          ? null
                          : <Badge variant="outline">Archived</Badge>}
                      </span>
                      {selected
                        ? <IconCheck aria-hidden="true" className="size-4" />
                        : null}
                    </button>
                  );
                })}
              </div>
              {canCreate ? (
                <>
                  <Separator />
                  <div className="flex flex-col">
                    {selectedProject === null ? null : (
                      <a
                        className={projectActionClass}
                        href={projectSettingsHref(selectedProject.id)}
                        onClick={() => setPickerOpen(false)}
                      >
                        <IconSettings aria-hidden="true" className="size-4 text-muted-foreground" />
                        <span>Project settings</span>
                      </a>
                    )}
                    <a
                      className={projectActionClass}
                      href="/review/settings/projects"
                      onClick={() => setPickerOpen(false)}
                    >
                      <IconFolderCog aria-hidden="true" className="size-4 text-muted-foreground" />
                      <span>Manage projects</span>
                    </a>
                    <button
                      className={projectActionClass}
                      onClick={showCreateForm}
                      type="button"
                    >
                      <IconPlus aria-hidden="true" className="size-4 text-muted-foreground" />
                      <span>New project</span>
                    </button>
                  </div>
                </>
              ) : null}
            </>
          )
          : (
            <form className="flex flex-col gap-4 p-2" onSubmit={(event) => void createProject(event)}>
              <PopoverTitle className="sr-only">Create project</PopoverTitle>
              {error === null
                ? null
                : (
                  <Alert variant="destructive">
                    <AlertDescription>{error.message}</AlertDescription>
                  </Alert>
                )}
              <FieldGroup>
                <Field data-invalid={error !== null}>
                  <FieldLabel
                    className="sr-only"
                    htmlFor="review-new-project-name"
                  >
                    Project name
                  </FieldLabel>
                  <Input
                    aria-invalid={error !== null}
                    autoFocus
                    autoComplete="off"
                    id="review-new-project-name"
                    maxLength={120}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Project name"
                    value={name}
                  />
                  <FieldError>
                    {name.length > 120 ? "Use 120 characters or fewer." : null}
                  </FieldError>
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={creating}
                  onClick={() => {
                    setError(null);
                    setName("");
                    setPickerScreen("projects");
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Back
                </Button>
                <Button disabled={creating || name.trim() === ""} size="sm" type="submit">
                  {creating ? "Creating…" : "Create project"}
                </Button>
              </div>
            </form>
          )}
      </PopoverContent>
    </Popover>
  );
}
