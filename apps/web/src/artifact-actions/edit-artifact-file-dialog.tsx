import {useEffect, useMemo, useRef, useState} from "react";

import {api, type ArtifactVersion, type Manifest} from "@/api/client";
import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Field, FieldDescription, FieldError, FieldGroup, FieldLabel} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {Skeleton} from "@/components/ui/skeleton";
import {Spinner} from "@/components/ui/spinner";
import {Textarea} from "@/components/ui/textarea";
import {formatBytes} from "@/lib/presentation";

import {newActionKey} from "./action-key.js";
import {describeActionError} from "./describe-error.js";
import type {ArtifactActionDialogProps} from "./dialog-props.js";
import {
  defaultEditablePath,
  editableEntries,
  maximumEditableBytes,
} from "./editable-entries.js";
import {isVersionConflict, publishEdit} from "./publish-edit.js";
import {
  decodeEditableText,
  encodeEditableText,
  UnsupportedTextError,
  type DecodedText,
} from "./text-codec.js";
import {createBrowserTransport, fetchVersionFile, type ArtifactActionResult} from "./transport.js";

type EditArtifactFileDialogProps = ArtifactActionDialogProps<ArtifactActionResult>;

/** The version the editor is reading and the version it expects to be current. */
interface EditSource {
  readonly currentVersionId: string;
  readonly manifest: Manifest;
  readonly number: number;
  readonly versionId: string;
}

type FileState =
  | {readonly status: "empty"}
  | {readonly status: "error"; readonly error: Error}
  | {readonly status: "loading"}
  | {readonly status: "ready"; readonly decoded: DecodedText}
  | {readonly status: "too_large"; readonly size: number};

/** Edits one text file of a version and publishes the result as a new version. */
export function EditArtifactFileDialog(props: EditArtifactFileDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!busy) props.onOpenChange(next);
      }}
      open={props.open}
    >
      <DialogContent className="sm:max-w-3xl">
        <EditorBody {...props} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  artifact,
  onBusyChange,
  onDone,
  onOpenChange,
  projectId,
  version,
}: EditArtifactFileDialogProps & {readonly onBusyChange: (busy: boolean) => void}) {
  const transport = useMemo(() => createBrowserTransport(), []);
  const idempotencyKey = useRef(newActionKey("edit"));
  const [source, setSource] = useState<EditSource>({
    currentVersionId: artifact.currentVersionId,
    manifest: version.manifest,
    number: version.version.number,
    versionId: version.version.id,
  });
  const [path, setPath] = useState<string | null>(
    () => defaultEditablePath(version.manifest.entries, version.manifest.entryPath),
  );
  const [file, setFile] = useState<FileState>({status: "loading"});
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [conflict, setConflict] = useState<ArtifactVersion | null>(null);
  // The server's advertised bound replaces the mirrored default once known.
  const [maximumBytes, setMaximumBytes] = useState(maximumEditableBytes);

  useEffect(() => {
    let current = true;
    api.session().then(
      (session) => {
        if (current) setMaximumBytes(session.capabilities.editing.maximumTextFileBytes);
        return undefined;
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  const entries = useMemo(() => editableEntries(source.manifest.entries), [source]);
  const entry = entries.find((candidate) => candidate.path === path);
  const pathItems = useMemo(
    () => entries.map((candidate) => ({label: candidate.path, value: candidate.path})),
    [entries],
  );

  useEffect(() => {
    if (entry === undefined) {
      setFile({status: "empty"});
      return undefined;
    }
    if (entry.size > maximumBytes) {
      setFile({size: entry.size, status: "too_large"});
      return undefined;
    }
    const controller = new AbortController();
    const load = async () => {
      setFile({status: "loading"});
      try {
        const bytes = await fetchVersionFile(transport, {
          artifactId: artifact.id,
          path: entry.path,
          projectId,
          signal: controller.signal,
          versionId: source.versionId,
        });
        const decoded = decodeEditableText(bytes);
        setText(decoded.text);
        setFile({decoded, status: "ready"});
      } catch (caught) {
        if (controller.signal.aborted) return;
        setFile({
          error: caught instanceof Error ? caught : new Error("The file could not be loaded."),
          status: "error",
        });
      }
    };
    void load();
    return () => controller.abort();
  }, [artifact.id, entry, maximumBytes, projectId, source.versionId, transport]);

  const decoded = file.status === "ready" ? file.decoded : null;
  const dirty = decoded !== null && text !== decoded.text;
  const encodedSize = useMemo(
    () => decoded === null ? 0 : encodeEditableText({...decoded, text}).byteLength,
    [decoded, text],
  );
  const tooLarge = encodedSize > maximumBytes;
  const viewingOlderVersion = source.versionId !== source.currentVersionId;
  const canSave = decoded !== null && dirty && !tooLarge && !pending && conflict === null;

  const save = async () => {
    if (decoded === null || entry === undefined || !canSave) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await publishEdit(transport, {
        artifactId: artifact.id,
        baseVersionId: source.versionId,
        bytes: encodeEditableText({...decoded, text}),
        expectedCurrentVersionId: source.currentVersionId,
        idempotencyKey: idempotencyKey.current,
        maximumBytes,
        mediaType: entry.mediaType,
        path: entry.path,
        projectId,
      });
      onDone(result);
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof Error && isVersionConflict(caught)) {
        await showConflict(caught);
      } else {
        setError(caught instanceof Error ? caught : new Error("Saving failed."));
      }
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  };

  /** Reads the actual current version so the conflict names what won. */
  const showConflict = async (cause: Error) => {
    try {
      setConflict((await api.artifact(projectId, artifact.id)).current);
    } catch {
      setError(cause);
    }
  };

  const reloadCurrent = () => {
    if (conflict === null) return;
    const manifest = conflict.manifest;
    setSource({
      currentVersionId: conflict.version.id,
      manifest,
      number: conflict.version.number,
      versionId: conflict.version.id,
    });
    setPath((previous) =>
      previous !== null && editableEntries(manifest.entries).some((candidate) => candidate.path === previous)
        ? previous
        : defaultEditablePath(manifest.entries, manifest.entryPath));
    setConflict(null);
    setError(null);
    idempotencyKey.current = newActionKey("edit");
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit file</DialogTitle>
        <DialogDescription>
          Saving publishes a new version of {artifact.name}. Earlier versions are never changed.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {viewingOlderVersion ? (
          <Alert>
            <AlertTitle>Editing version {source.number}</AlertTitle>
            <AlertDescription>
              This is not the current version. The new version is built from version {source.number}, so changes published after it are not carried over.
            </AlertDescription>
          </Alert>
        ) : null}
        {conflict === null ? null : (
          <Alert variant="destructive">
            <AlertTitle>Version {conflict.version.number} was published first</AlertTitle>
            <AlertDescription>
              Your changes were not saved and nothing was overwritten. Reload to edit the current version; copy your text first if you want to keep it.
              <Button className="mt-2 w-fit" onClick={reloadCurrent} size="sm" type="button" variant="outline">
                Reload version {conflict.version.number}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="edit-artifact-file-path">File</FieldLabel>
          <Select
            disabled={pending || dirty || entries.length === 0}
            items={pathItems}
            onValueChange={(next) => {
              if (next === null) return;
              setPath(next);
              idempotencyKey.current = newActionKey("edit");
            }}
            value={path}
          >
            <SelectTrigger className="w-full font-mono" id="edit-artifact-file-path">
              <SelectValue placeholder="Choose a text file" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {entries.map((candidate) => (
                  <SelectItem key={candidate.path} value={candidate.path}>
                    {candidate.path}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            {dirty
              ? "Save or reset your changes before switching files."
              : "Only text files can be edited. Binary files such as images are not listed."}
          </FieldDescription>
        </Field>
        <FileBody
          file={file}
          onTextChange={(next) => {
            setText(next);
            idempotencyKey.current = newActionKey("edit");
          }}
          text={text}
          maximumBytes={maximumBytes}
          tooLarge={tooLarge}
        />
        {error === null ? null : (
          <Field data-invalid>
            <FieldError>{describeActionError(error)}</FieldError>
          </Field>
        )}
      </FieldGroup>
      <DialogFooter>
        {decoded === null ? null : (
          <p className="mr-auto self-center text-xs text-muted-foreground">
            UTF-8{decoded.bom ? " with byte order mark" : ""}, {decoded.lineEnding === "crlf" ? "CRLF" : "LF"} line endings kept
          </p>
        )}
        <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={!dirty || pending}
          onClick={() => decoded !== null && setText(decoded.text)}
          type="button"
          variant="outline"
        >
          Reset
        </Button>
        <Button disabled={!canSave} onClick={() => void save()} type="button">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Save new version
        </Button>
      </DialogFooter>
    </>
  );
}

function FileBody({
  file,
  maximumBytes,
  onTextChange,
  text,
  tooLarge,
}: {
  readonly file: FileState;
  readonly maximumBytes: number;
  readonly onTextChange: (text: string) => void;
  readonly text: string;
  readonly tooLarge: boolean;
}) {
  if (file.status === "loading") return <Skeleton className="h-72 w-full" />;
  if (file.status === "empty") {
    return (
      <Alert>
        <AlertTitle>No text files</AlertTitle>
        <AlertDescription>This version contains only files that cannot be edited as text.</AlertDescription>
      </Alert>
    );
  }
  if (file.status === "too_large") {
    return (
      <Alert variant="destructive">
        <AlertTitle>File is too large to edit</AlertTitle>
        <AlertDescription>
          This file is {formatBytes(file.size)}. Files above {formatBytes(maximumBytes)} must be republished from your coding agent.
        </AlertDescription>
      </Alert>
    );
  }
  if (file.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>{file.error instanceof UnsupportedTextError ? "This file cannot be edited here" : "The file could not be loaded"}</AlertTitle>
        <AlertDescription>{describeActionError(file.error)}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Field data-invalid={tooLarge ? true : undefined}>
      <FieldLabel className="sr-only" htmlFor="edit-artifact-file-text">File contents</FieldLabel>
      <Textarea
        aria-invalid={tooLarge ? true : undefined}
        className="h-72 resize-none font-mono text-xs"
        id="edit-artifact-file-text"
        onChange={(event) => onTextChange(event.currentTarget.value)}
        spellCheck={false}
        value={text}
        wrap="off"
      />
      {tooLarge ? (
        <FieldError>Edited files are limited to {formatBytes(maximumBytes)}.</FieldError>
      ) : null}
    </Field>
  );
}
