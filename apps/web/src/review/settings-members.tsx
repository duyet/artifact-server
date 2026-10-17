import {useEffect, useState} from "react";
import {toast} from "sonner";

import { api, type InstallationMember } from "@/api/client";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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

/** Administrator-only installation member lifecycle surface. */
export function MembersScreen() {
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [admitOpen, setAdmitOpen] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"administrator" | "member">("member");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers(await api.members());
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const admit = async () => {
    setPending(true);
    setError(null);
    try {
      await api.admitMember(displayName, email, role);
      setDisplayName("");
      setEmail("");
      setRole("member");
      setAdmitOpen(false);
      toast.success("Member admitted.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member admission failed."));
    } finally {
      setPending(false);
    }
  };

  const deactivate = async (memberId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.deactivateMember(memberId);
      setDeactivating(null);
      toast.success("Member deactivated.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member deactivation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={(
          <Dialog onOpenChange={setAdmitOpen} open={admitOpen}>
            <DialogTrigger render={<Button type="button" />}>Admit member</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Admit member</DialogTitle>
                <DialogDescription>
                  Admit one person to this installation. Every active member can manage artifacts
                  in every project.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="member-name">Display name</FieldLabel>
                  <Input
                    id="member-name"
                    maxLength={200}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    value={displayName}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="member-email">Email</FieldLabel>
                  <Input
                    id="member-email"
                    maxLength={320}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    type="email"
                    value={email}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="member-role">Role</FieldLabel>
                  <NativeSelect
                    className="w-full"
                    id="member-role"
                    onChange={(event) => {
                      setRole(event.currentTarget.value === "administrator"
                        ? "administrator"
                        : "member");
                    }}
                    value={role}
                  >
                    <NativeSelectOption value="member">Member</NativeSelectOption>
                    <NativeSelectOption value="administrator">
                      Administrator
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button
                  disabled={pending || displayName.trim() === "" || email.trim() === ""}
                  onClick={() => void admit()}
                  type="button"
                >
                  {pending ? <ButtonSpinner /> : null}
                  {pending ? "Admitting…" : "Admit member"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description="One installation has one closed member group. There is no public sign-up or project-specific membership."
        eyebrow="Administration"
        title="Members"
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {loading && members.length === 0
        ? (
          <Card aria-busy="true">
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        )
        : members.length === 0
          ? error === null
            ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle aria-level={2} role="heading">No members</EmptyTitle>
                  <EmptyDescription>Admit the first member to this installation.</EmptyDescription>
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
                      <TableHead className="pl-4">Member</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Admitted</TableHead>
                      <TableHead className="pr-4 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className="pl-4">
                          <p className="font-medium">{member.displayName}</p>
                          <p className="text-xs text-muted-foreground">{member.email}</p>
                        </TableCell>
                        <TableCell className="capitalize">{member.role}</TableCell>
                        <TableCell>
                          <StatusBadge tone={member.status === "active" ? "primary" : "neutral"}>
                            {member.status}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatTimestamp(member.createdAt)}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          {member.status === "inactive"
                            ? null
                            : (
                              <AlertDialog
                                onOpenChange={(open) => setDeactivating(open ? member.id : null)}
                                open={deactivating === member.id}
                              >
                                <AlertDialogTrigger
                                  render={<Button size="xs" type="button" variant="ghost" />}
                                >
                                  Deactivate
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Deactivate member</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {member.displayName} will lose new browser sessions and API access.
                                      Existing artifact records and attribution remain unchanged.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      disabled={pending}
                                      onClick={() => void deactivate(member.id)}
                                      variant="destructive"
                                    >
                                      {pending ? <ButtonSpinner /> : null}
                                      {pending ? "Deactivating…" : "Deactivate member"}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
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
