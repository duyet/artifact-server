import {useEffect, useState} from "react";
import {toast} from "sonner";

import {
  api,
  type InstallationMember,
  type IssuedApiKey,
  type ManagedApiKey,
  type PrincipalCapability,
} from "@/api/client";
import { ButtonSpinner, ErrorPanel, PageHeader, StatusBadge } from "@/components/product";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestamp } from "@/lib/presentation";

const capabilities: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: PrincipalCapability;
}[] = [
  { description: "List and read artifact metadata.", label: "Read artifacts", value: "artifact:read" },
  { description: "Create new artifacts.", label: "Create artifacts", value: "artifact:create" },
  { description: "Publish new immutable versions.", label: "Publish versions", value: "artifact:publish:any" },
  { description: "Restore, change tags and access, or tombstone.", label: "Manage artifacts", value: "artifact:manage:any" },
  { description: "Open account-required artifact content.", label: "Issue content sessions", value: "content-session:issue" },
  { description: "Create, rename, archive, and unarchive projects.", label: "Manage projects", value: "project:manage" },
  { description: "Register a coding agent and claim dispatched annotations.", label: "Connect agents", value: "agent:connect" },
  { description: "Read, reply to, and resolve review comments.", label: "Manage comments", value: "comment:write" },
];

/** Format one instant as the browser's local wall-clock minute value. */
export function formatDatetimeLocalMinimum(now: Date): string {
  const localMilliseconds = now.getTime() - now.getTimezoneOffset() * 60_000;
  return new Date(localMilliseconds).toISOString().slice(0, 16);
}

/** Administrator-only managed API key issuance and lifecycle surface. */
export function ApiKeysScreen() {
  const [apiKeys, setApiKeys] = useState<readonly ManagedApiKey[]>([]);
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("");
  const [memberId, setMemberId] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<
    readonly PrincipalCapability[]
  >([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedKeys, loadedMembers] = await Promise.all([
        api.apiKeys(),
        api.members(),
      ]);
      setApiKeys(loadedKeys);
      setMembers(loadedMembers);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggleCapability = (capability: PrincipalCapability, checked: boolean) => {
    setSelectedCapabilities((current) => checked
      ? [...current, capability]
      : current.filter((candidate) => candidate !== capability));
  };

  const issue = async () => {
    setPending(true);
    setError(null);
    try {
      const expirationDate = new Date(expiration);
      const result = await api.issueApiKey(
        name,
        expirationDate.toISOString(),
        selectedCapabilities,
        memberId === "" ? undefined : memberId,
      );
      setIssueOpen(false);
      setIssued(result);
      setName("");
      setExpiration("");
      setMemberId("");
      setSelectedCapabilities([]);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key issuance failed."));
    } finally {
      setPending(false);
    }
  };

  const rotate = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      setIssued(await api.rotateApiKey(keyId));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key rotation failed."));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeApiKey(keyId);
      setRevoking(null);
      toast.success("API key revoked.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key revocation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={(
          <Dialog onOpenChange={setIssueOpen} open={issueOpen}>
            <DialogTrigger render={<Button type="button" />}>Issue API key</DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Issue API key</DialogTitle>
                <DialogDescription>
                  The secret appears once. Give the key only the capabilities it needs and choose
                  a future expiration.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="max-h-[60svh] overflow-y-auto pr-1">
                <Field>
                  <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
                  <Input
                    id="api-key-name"
                    maxLength={200}
                    onChange={(event) => setName(event.currentTarget.value)}
                    value={name}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="api-key-expiration">Expires at</FieldLabel>
                  <Input
                    id="api-key-expiration"
                    min={formatDatetimeLocalMinimum(new Date())}
                    onChange={(event) => setExpiration(event.currentTarget.value)}
                    type="datetime-local"
                    value={expiration}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="api-key-owner">Owner</FieldLabel>
                  <NativeSelect
                    className="w-full"
                    id="api-key-owner"
                    onChange={(event) => setMemberId(event.currentTarget.value)}
                    value={memberId}
                  >
                    <NativeSelectOption value="">Service principal</NativeSelectOption>
                    {members.filter((member) => member.status === "active").map((member) => (
                      <NativeSelectOption key={member.id} value={member.id}>
                        {member.displayName} · {member.email}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <FieldSet>
                  <FieldLegend variant="label">Capabilities</FieldLegend>
                  <FieldGroup className="gap-3" data-slot="checkbox-group">
                    {capabilities.map((capability) => {
                      const checked = selectedCapabilities.includes(capability.value);
                      const id = `api-key-capability-${capability.value}`;
                      return (
                        <FieldLabel htmlFor={id} key={capability.value}>
                          <Field orientation="horizontal">
                            <Checkbox
                              checked={checked}
                              id={id}
                              onCheckedChange={(next) => toggleCapability(capability.value, next)}
                            />
                            <FieldContent>
                              <FieldTitle>{capability.label}</FieldTitle>
                              <FieldDescription>{capability.description}</FieldDescription>
                            </FieldContent>
                          </Field>
                        </FieldLabel>
                      );
                    })}
                  </FieldGroup>
                </FieldSet>
              </FieldGroup>
              <DialogFooter>
                <Button
                  disabled={pending
                    || name.trim() === ""
                    || expiration === ""
                    || selectedCapabilities.length === 0}
                  onClick={() => void issue()}
                  type="button"
                >
                  {pending ? <ButtonSpinner /> : null}
                  {pending ? "Issuing…" : "Issue API key"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description="Managed API keys have explicit capabilities, a required expiration, and revocation. Secrets are never shown again."
        eyebrow="Administration"
        title="API keys"
      />

      <SecretDialog issued={issued} onDiscard={() => setIssued(null)} />
      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {loading && apiKeys.length === 0
        ? (
          <Card aria-busy="true">
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        )
        : apiKeys.length === 0
          ? error === null
            ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle aria-level={2} role="heading">No managed API keys</EmptyTitle>
                  <EmptyDescription>
                    Issue a scoped key for automation or a compatible self-hosted MCP client.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
            : null
          : (
            <Card>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Key</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Capabilities</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="pr-4 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeys.map((apiKey) => (
                      <TableRow key={apiKey.id}>
                        <TableCell className="pl-4 align-top">
                          <p className="font-medium">{apiKey.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">{apiKey.prefix}</p>
                        </TableCell>
                        <TableCell className="align-top">
                          <StatusBadge tone={apiKey.revokedAt === null ? "primary" : "danger"}>
                            {apiKey.revokedAt === null ? "Active" : "Revoked"}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="max-w-sm align-top whitespace-normal">
                          <div className="flex flex-wrap gap-1">
                            {apiKey.capabilities.map((capability) => (
                              <StatusBadge key={capability}>{capability}</StatusBadge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-muted-foreground">
                          {formatTimestamp(apiKey.expiresAt)}
                        </TableCell>
                        <TableCell className="pr-4 align-top">
                          {apiKey.revokedAt === null
                            ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  disabled={pending}
                                  onClick={() => void rotate(apiKey.id)}
                                  size="xs"
                                  type="button"
                                  variant="outline"
                                >
                                  Rotate
                                </Button>
                                <AlertDialog
                                  onOpenChange={(open) => setRevoking(open ? apiKey.id : null)}
                                  open={revoking === apiKey.id}
                                >
                                  <AlertDialogTrigger render={<Button size="xs" type="button" variant="ghost" />}>
                                    Revoke
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Revoke API key</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Requests using {apiKey.name} will stop immediately. Revocation does
                                        not remove prior action attribution.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        disabled={pending}
                                        onClick={() => void revoke(apiKey.id)}
                                        variant="destructive"
                                      >
                                        {pending ? <ButtonSpinner /> : null}
                                        {pending ? "Revoking…" : "Revoke API key"}
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            )
                            : null}
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

function SecretDialog({
  issued,
  onDiscard,
}: {
  readonly issued: IssuedApiKey | null;
  readonly onDiscard: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (issued === null) return null;
  const copyToken = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
      toast.success("API key copied.");
    } catch {
      toast.error("Unable to copy. Select the key and copy it manually.");
    }
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onDiscard();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy API key now</DialogTitle>
          <DialogDescription>
            This secret is displayed once. Store it in the intended client's secret input or a
            deployment secret manager. Artifact Server cannot show it again.
          </DialogDescription>
        </DialogHeader>
        <code className="max-h-32 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs break-all">
          {issued.token}
        </code>
        <DialogFooter>
          <Button
            onClick={() => void copyToken()}
            type="button"
          >
            {copied ? "Copied" : "Copy API key"}
          </Button>
          <Button onClick={onDiscard} type="button" variant="outline">
            I stored it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
