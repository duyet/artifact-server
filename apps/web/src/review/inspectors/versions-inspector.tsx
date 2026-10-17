import {useState} from "react";

import type {Version} from "@/api/client";
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
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Field, FieldGroup, FieldLabel} from "@/components/ui/field";
import {Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Spinner} from "@/components/ui/spinner";
import {formatTimestamp} from "@/lib/presentation";
import {compactId} from "../review-location.ts";
import {InspectorSection, InspectorStack} from "./inspector-layout.tsx";

export interface VersionListItem {
  readonly links: {readonly review: string; readonly version: string};
  readonly version: Version;
}

export function VersionsInspector({
  canManage,
  comparisonLoading,
  currentVersionId,
  onCompare,
  onMakeCurrent,
  onSelect,
  selectedVersionId,
  versions,
}: {
  readonly canManage: boolean;
  readonly comparisonLoading: boolean;
  readonly currentVersionId: string;
  readonly onCompare: (fromVersionId: string, toVersionId: string) => Promise<void>;
  readonly onMakeCurrent: (
    versionId: string,
    expectedCurrentVersionId: string,
  ) => Promise<boolean>;
  readonly onSelect: (versionId: string) => void;
  readonly selectedVersionId: string | null;
  readonly versions: readonly VersionListItem[];
}) {
  const [fromVersionId, setFromVersionId] = useState(
    versions.at(-1)?.version.id ?? currentVersionId,
  );
  const [toVersionId, setToVersionId] = useState(currentVersionId);
  const versionItems = versions.map(({version}) => ({
    label: `Version ${version.number}`,
    value: version.id,
  }));
  return (
    <InspectorStack>
      {versions.length < 2 ? null : (
        <InspectorSection count={2} title="Compare versions">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onCompare(fromVersionId, toVersionId);
            }}
          >
            <FieldGroup className="gap-3">
              <VersionSelect
                id="review-compare-from"
                items={versionItems}
                label="From"
                onChange={setFromVersionId}
                value={fromVersionId}
              />
              <VersionSelect
                id="review-compare-to"
                items={versionItems}
                label="To"
                onChange={setToVersionId}
                value={toVersionId}
              />
              <Button
                className="w-fit"
                disabled={comparisonLoading || fromVersionId === toVersionId}
                size="sm"
                type="submit"
                variant="outline"
              >
                {comparisonLoading ? <Spinner data-icon="inline-start" /> : null}
                {comparisonLoading ? "Comparing…" : "Compare"}
              </Button>
            </FieldGroup>
          </form>
        </InspectorSection>
      )}
      <InspectorSection count={versions.length} title="Immutable history">
        <ol className="flex flex-col gap-1">
          {versions.map(({version}) => {
            const selected = selectedVersionId === version.id;
            return (
              <li className="flex items-center gap-1" key={version.id}>
                <Button
                  aria-current={selected ? "true" : undefined}
                  className="h-auto min-w-0 flex-1 justify-between gap-3 py-1.5 data-[selected=true]:bg-muted"
                  data-selected={selected}
                  onClick={() => onSelect(version.id)}
                  type="button"
                  variant="ghost"
                >
                  <span className="flex min-w-0 flex-col items-start">
                    <span>Version {version.number}</span>
                    <time className="text-xs font-normal text-muted-foreground" dateTime={version.createdAt}>
                      {formatTimestamp(version.createdAt)}
                    </time>
                  </span>
                  {version.id === currentVersionId
                    ? <Badge variant="secondary">current</Badge>
                    : <span className="font-mono text-xs font-normal text-muted-foreground">{compactId(version.id)}</span>}
                </Button>
                {!canManage || version.id === currentVersionId ? null : (
                  <MakeCurrentControl
                    expectedCurrentVersionId={currentVersionId}
                    onConfirm={onMakeCurrent}
                    version={version}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </InspectorSection>
    </InspectorStack>
  );
}

function VersionSelect({
  id,
  items,
  label,
  onChange,
  value,
}: {
  readonly id: string;
  readonly items: readonly {readonly label: string; readonly value: string}[];
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        value={value}
      >
        <SelectTrigger className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function MakeCurrentControl({
  expectedCurrentVersionId,
  onConfirm,
  version,
}: {
  readonly expectedCurrentVersionId: string;
  readonly onConfirm: (
    versionId: string,
    expectedCurrentVersionId: string,
  ) => Promise<boolean>;
  readonly version: Version;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    setPending(true);
    await onConfirm(version.id, expectedCurrentVersionId);
    setPending(false);
    setOpen(false);
  };
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger render={<Button className="shrink-0" size="sm" variant="outline" />}>
        Make current
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Make Version {version.number} current?</AlertDialogTitle>
          <AlertDialogDescription>
            The stable artifact link will point to Version {version.number}. No saved version is changed or duplicated.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => void confirm()} type="button">
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Making current…" : "Make current"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
