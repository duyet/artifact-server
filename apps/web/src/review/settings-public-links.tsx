import {useEffect, useMemo, useState} from "react";

import {
  api,
  type MakePublicLinkPrivateItem,
  type PublicLinkItem,
  type PublicLinkMutationResult,
  type PublicLinkPage,
} from "@/api/client";
import {ButtonSpinner, ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {Button, ButtonLink} from "@/components/ui/button";
import {Card, CardContent, CardFooter} from "@/components/ui/card";
import {Checkbox} from "@/components/ui/checkbox";
import {FieldError} from "@/components/ui/field";
import {Skeleton} from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {formatTimestamp} from "@/lib/presentation";

const maximumBulkSize = 100;

type FailedMutationResult = Extract<
  PublicLinkMutationResult,
  {readonly status: "failed"}
>;

interface FailedMutation {
  readonly command: MakePublicLinkPrivateItem;
  readonly item: PublicLinkItem;
  readonly result: FailedMutationResult;
}

/** Administrator-only cross-project inventory and shutdown surface for public links. */
export function PublicLinksScreen() {
  const [pages, setPages] = useState<readonly PublicLinkPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<readonly PublicLinkItem[]>([]);
  const [failures, setFailures] = useState<readonly FailedMutation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const loadedItems = useMemo(
    () => pages.flatMap((page) => page.publicLinks),
    [pages],
  );
  const currentPage = pages[pageIndex] ?? null;
  const visibleItems = currentPage?.publicLinks ?? [];
  const selectedItems = loadedItems.filter((item) =>
    selectedKeys.has(selectionKey(item))
  );
  const fullyLoaded = pages.length > 0 && pages.at(-1)?.nextCursor === null;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedKeys.has(selectionKey(item))
  );

  const loadFirstPage = async () => {
    setLoading(true);
    setError(null);
    try {
      const firstPage = await api.publicLinks(null);
      setPages([firstPage]);
      setPageIndex(0);
      setSelectedKeys(new Set());
      setFailures([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link inventory failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFirstPage();
  }, []);

  const showNextPage = async () => {
    const cached = pages[pageIndex + 1];
    if (cached !== undefined) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (currentPage?.nextCursor === null || currentPage === null) return;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await api.publicLinks(currentPage.nextCursor);
      setPages((current) => [...current, nextPage]);
      setPageIndex((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link page failed."));
    } finally {
      setLoading(false);
    }
  };

  const selectItems = (items: readonly PublicLinkItem[], checked: boolean) => {
    setSelectionMessage(null);
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of items) {
        const key = selectionKey(item);
        if (!checked) {
          next.delete(key);
          continue;
        }
        if (next.size >= maximumBulkSize && !next.has(key)) {
          setSelectionMessage(
            `Bulk changes are limited to ${maximumBulkSize} public links. Clear part of the selection before adding more.`,
          );
          break;
        }
        next.add(key);
      }
      return next;
    });
  };

  const removeItems = (keys: ReadonlySet<string>) => {
    setPages((current) => current.map((page) => ({
      ...page,
      publicLinks: page.publicLinks.filter((item) => !keys.has(selectionKey(item))),
    })));
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const executeMutation = async (
    items: readonly PublicLinkItem[],
    commands: readonly MakePublicLinkPrivateItem[],
    retainedFailures: readonly FailedMutation[] = [],
  ) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.makePublicLinksPrivate(commands);
      const itemByKey = new Map(items.map((item) => [selectionKey(item), item]));
      const commandByKey = new Map(commands.map((command) => [commandKey(command), command]));
      const succeeded = new Set<string>();
      const nextFailures: FailedMutation[] = [...retainedFailures];
      for (const result of response.results) {
        const key = resultKey(result);
        if (result.status === "made_private") {
          succeeded.add(key);
          continue;
        }
        const item = itemByKey.get(key);
        const command = commandByKey.get(key);
        if (item === undefined || command === undefined) {
          throw new Error("A public-link mutation result did not match its bounded request.");
        }
        nextFailures.push({command, item, result});
      }
      removeItems(succeeded);
      setFailures(nextFailures);
      setSelectedKeys(new Set(nextFailures.map(({item}) => selectionKey(item))));
      if (response.summary.succeeded > 0) {
        setNotice(
          `${response.summary.succeeded} public ${response.summary.succeeded === 1 ? "link is" : "links are"} now private. ${response.warning}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Making public links private failed."));
    } finally {
      setPending(false);
    }
  };

  const confirmMutation = async () => {
    const items = confirmation;
    setConfirmation([]);
    await executeMutation(items, items.map(makePrivateCommand));
  };

  const retryFailures = async () => {
    const retained = failures.filter(({result}) =>
      result.retry === "not_retryable"
    );
    const retryable = failures.filter(({result}) =>
      result.retry !== "not_retryable"
    );
    setPending(true);
    setError(null);
    try {
      const prepared = await Promise.all(retryable.map(async (failure) => {
        if (failure.result.retry === "same_command") return failure;
        const details = await api.artifact(
          failure.item.project.id,
          failure.item.artifact.id,
        );
        if (details.artifact.accessSetting === "account_required") {
          return {alreadyPrivate: failure.item} as const;
        }
        return {
          command: {
            ...failure.command,
            expectedCurrentVersionId: details.artifact.currentVersionId,
            idempotencyKey: crypto.randomUUID(),
          },
          item: {
            ...failure.item,
            artifact: details.artifact,
            currentVersion: details.current.version,
          },
        } as const;
      }));
      const alreadyPrivate = new Set(prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [selectionKey(entry.alreadyPrivate)] : []
      ));
      removeItems(alreadyPrivate);
      const ready = prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [] : [entry]
      );
      if (ready.length === 0) {
        setFailures(retained);
        if (alreadyPrivate.size > 0) {
          setNotice("The remaining public links were already private when their current state was refreshed.");
        }
        return;
      }
      await executeMutation(
        ready.map(({item}) => item),
        ready.map(({command}) => command),
        retained,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Retrying public links failed."));
    } finally {
      setPending(false);
    }
  };

  if (loading && pages.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          description="Loading active public links across every project."
          eyebrow="Administration"
          title="Public links"
        />
        <Card aria-busy="true">
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }
  if (error !== null && pages.length === 0) {
    return <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        actions={(
          <Button onClick={() => void loadFirstPage()} type="button" variant="outline">
            Reload
          </Button>
        )}
        description="See every active artifact that currently allows public-link access, then make individual links or a bounded selection private."
        eyebrow="Administration"
        title="Public links"
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />}
      {notice === null ? null : (
        <Alert>
          <AlertTitle>Public access changed</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {failures.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertTitle>
            {failures.length} {failures.length === 1 ? "link was" : "links were"} not changed
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-left text-sm">
              {failures.map(({item, result}) => (
                <li key={selectionKey(item)}>
                  {item.project.name} / {item.artifact.name}: {result.error.message}
                </li>
              ))}
            </ul>
            {failures.some(({result}) => result.retry !== "not_retryable")
              ? (
                <Button
                  className="mt-3"
                  disabled={pending}
                  onClick={() => void retryFailures()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {pending ? <ButtonSpinner /> : null}
                  {pending ? "Retrying…" : "Retry failed"}
                </Button>
              )
              : null}
          </AlertDescription>
        </Alert>
      )}

      {loadedItems.length === 0 && fullyLoaded
        ? (
          <StatePanel
            description="No active artifact in this installation currently allows public-link access."
            title="No public links"
          />
        )
        : (
          <>
            <Card role="region" aria-label="Bulk selection" size="sm">
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={visibleItems.length === 0}
                    onClick={() => selectItems(visibleItems, true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Select visible ({visibleItems.length})
                  </Button>
                  <Button
                    disabled={loadedItems.length === 0 || loadedItems.length > maximumBulkSize}
                    onClick={() => selectItems(loadedItems, true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {fullyLoaded ? "Select all" : "Select all loaded"} ({loadedItems.length})
                  </Button>
                  <Button
                    disabled={selectedKeys.size === 0}
                    onClick={() => setSelectedKeys(new Set())}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Clear selection
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {selectedItems.length} selected · maximum {maximumBulkSize}
                  </span>
                  <Button
                    disabled={pending || selectedItems.length === 0}
                    onClick={() => setConfirmation(selectedItems)}
                    size="sm"
                    type="button"
                  >
                    Make {selectedItems.length} private
                  </Button>
                </div>
              </CardContent>
              <CardFooter className="flex-col items-start gap-1 text-xs leading-5 text-muted-foreground">
                <p>
                  {fullyLoaded
                    ? "All inventory pages are loaded, so Select all covers every listed public link."
                    : "More inventory pages exist. Select all loaded never includes pages you have not visited."}
                  {loadedItems.length > maximumBulkSize
                    ? ` Select visible or choose up to ${maximumBulkSize} links for one bulk change.`
                    : ""}
                </p>
                {selectionMessage === null ? null : <FieldError>{selectionMessage}</FieldError>}
              </CardFooter>
            </Card>

            <Card>
              <CardContent className="px-0">
                <Table aria-label="Public links inventory" className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10 pl-4">
                        <Checkbox
                          aria-label="Select all visible public links"
                          checked={allVisibleSelected}
                          onCheckedChange={(checked) => selectItems(visibleItems, checked)}
                        />
                      </TableHead>
                      <TableHead className="w-[34%] pl-4 sm:w-1/3">Artifact</TableHead>
                      <TableHead>Public link</TableHead>
                      <TableHead className="w-24 pr-4 text-right sm:w-40">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleItems.length === 0
                      ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell className="px-4 py-6 text-center whitespace-normal text-muted-foreground" colSpan={4}>
                            {currentPage?.nextCursor === null
                              ? "Every public link on this page is now private. Return to a previous page to inspect the remaining loaded links."
                              : "Every public link on this loaded page is now private. Continue to the next page to inspect older public links."}
                          </TableCell>
                        </TableRow>
                      )
                      : visibleItems.map((item) => {
                        const selected = selectedKeys.has(selectionKey(item));
                        return (
                          <TableRow data-state={selected ? "selected" : undefined} key={selectionKey(item)}>
                            <TableCell className="pl-4">
                              <Checkbox
                                aria-label={`Select ${item.artifact.name}`}
                                checked={selected}
                                onCheckedChange={(checked) => selectItems([item], checked)}
                              />
                            </TableCell>
                            <TableCell className="pl-4 overflow-hidden">
                              <div className="flex min-w-0 items-center gap-2">
                                <a
                                  className="truncate font-medium hover:underline"
                                  href={`/review?${new URLSearchParams({
                                    artifact: item.artifact.id,
                                    project: item.project.id,
                                  })}`}
                                >
                                  {item.artifact.name}
                                </a>
                                {item.project.archivedAt === null
                                  ? null
                                  : <StatusBadge>Archived</StatusBadge>}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">{item.project.name}</p>
                            </TableCell>
                            <TableCell className="overflow-hidden pr-4">
                              <a
                                className="block truncate font-mono text-xs hover:underline"
                                href={item.links.public}
                                rel="noreferrer"
                                target="_blank"
                                title={item.links.public}
                              >
                                {item.links.public}
                              </a>
                              <p className="truncate text-xs text-muted-foreground">
                                <span>Version {item.currentVersion.number}</span>
                                <span aria-hidden="true"> · </span>
                                <span>Saved {formatTimestamp(item.currentVersion.createdAt)}</span>
                              </p>
                            </TableCell>
                            <TableCell className="pr-4">
                              <div className="flex flex-col items-end gap-1 sm:flex-row sm:justify-end sm:gap-2">
                                <ButtonLink
                                  href={item.links.public}
                                  rel="noreferrer"
                                  size="xs"
                                  target="_blank"
                                  variant="outline"
                                >
                                  Open
                                </ButtonLink>
                                <Button
                                  disabled={pending}
                                  onClick={() => setConfirmation([item])}
                                  size="xs"
                                  type="button"
                                  variant="ghost"
                                >
                                  Make private
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <nav aria-label="Public links pagination" className="flex items-center justify-between">
              <Button
                disabled={loading || pageIndex === 0}
                onClick={() => setPageIndex((current) => current - 1)}
                type="button"
                variant="outline"
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {pageIndex + 1}</span>
              <Button
                disabled={loading || currentPage?.nextCursor === null}
                onClick={() => void showNextPage()}
                type="button"
                variant="outline"
              >
                {loading ? <ButtonSpinner /> : null}
                {loading ? "Loading…" : "Next"}
              </Button>
            </nav>
          </>
        )}

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setConfirmation([]);
        }}
        open={confirmation.length > 0}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Make {confirmation.length} public {confirmation.length === 1 ? "link" : "links"} private?
            </AlertDialogTitle>
            <AlertDialogDescription>
              New requests to successful items will require an admitted account. Copies already
              downloaded or cached outside Artifact Server cannot be recalled. Each item is checked
              against the current version shown when you selected it. If an artifact changed, that
              item fails without changing its access and can be retried after refreshing its version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={() => void confirmMutation()}>
              {pending ? <ButtonSpinner /> : null}
              {pending ? "Making private…" : "Make private"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function makePrivateCommand(item: PublicLinkItem): MakePublicLinkPrivateItem {
  return {
    artifactId: item.artifact.id,
    expectedCurrentVersionId: item.artifact.currentVersionId,
    idempotencyKey: crypto.randomUUID(),
    projectId: item.project.id,
  };
}

function selectionKey(item: PublicLinkItem): string {
  return `${item.project.id}\0${item.artifact.id}`;
}

function commandKey(command: MakePublicLinkPrivateItem): string {
  return `${command.projectId}\0${command.artifactId}`;
}

function resultKey(result: PublicLinkMutationResult): string {
  return `${result.projectId}\0${result.artifactId}`;
}
