import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {z} from "zod";

import {
  api,
  type AgentDispatch,
  type AgentPresence,
  type CommentAnchor,
  type CommentReply,
  type CommentThread,
  type CommentThreadDetails,
  type CommentThreadQuery,
} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {Alert, AlertDescription} from "@/components/ui/alert";
import {Avatar, AvatarFallback} from "@/components/ui/avatar";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Empty, EmptyHeader, EmptyTitle} from "@/components/ui/empty";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import {Skeleton} from "@/components/ui/skeleton";
import {Spinner} from "@/components/ui/spinner";
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group";
import {formatTimestamp} from "@/lib/presentation";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {loadDispatchIndex} from "@/components/dispatch/dispatch-index";
import {
  dispatchIsCancelable,
  DispatchStateChip,
} from "@/components/dispatch/dispatch-state";
import {useDispatchUndo} from "@/components/dispatch/dispatch-toast";
import {PresenceAvatar} from "@/components/dispatch/presence-avatar";
import {SendToAgentControl} from "@/components/dispatch/send-to-agent-dialog";
import {
  reviewAnchorSchema,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

const threadPageSize = 100;
const conversationLoadConcurrency = 6;

function agentPresenceSummary(agents: readonly AgentPresence[] | null): string {
  if (agents === null) return "Checking presence…";
  const connectedCount = agents.filter((agent) => agent.connected).length;
  const offlineCount = agents.length - connectedCount;
  if (offlineCount === 0) {
    return connectedCount === 0 ? "No agents connected" : `${connectedCount} connected`;
  }
  return `${connectedCount} connected · ${offlineCount} offline`;
}

function threadQuery(
  versionId: string,
  since: string | null,
  cursor: string | null,
  dispatched: "exclude" | "include" | "only" | null = null,
): CommentThreadQuery {
  return {
    cursor,
    dispatched,
    limit: threadPageSize,
    since,
    state: null,
    versionId,
  };
}

async function loadAllThreads(
  projectId: string,
  artifactId: string,
  versionId: string,
  since: string | null,
  dispatched: "exclude" | "include" | "only" | null = null,
  cursor: string | null = null,
  collected: readonly CommentThread[] = [],
): Promise<readonly CommentThread[]> {
  const page = await api.comments(
    projectId,
    artifactId,
    threadQuery(versionId, since, cursor, dispatched),
  );
  const next = [...collected, ...page.items];
  return page.nextCursor === null
    ? next
    : loadAllThreads(
      projectId,
      artifactId,
      versionId,
      since,
      dispatched,
      page.nextCursor,
      next,
    );
}

function toAnnotation(thread: CommentThread): ReviewAnnotation {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  return {
    anchor: parsed.success ? parsed.data : null,
    body: thread.body,
    state: thread.state,
    threadId: thread.id,
  };
}

async function loadConversations(
  projectId: string,
  artifactId: string,
  threads: readonly CommentThread[],
): Promise<readonly CommentThreadDetails[]> {
  const conversations = new Map<string, CommentThreadDetails>();
  const worker = async (index: number): Promise<void> => {
    const thread = threads[index];
    if (thread === undefined) return;
    const details = await api.comment(projectId, artifactId, thread.id);
    conversations.set(thread.id, details);
    await worker(index + conversationLoadConcurrency);
  };
  await Promise.all(
    Array.from(
      {length: Math.min(conversationLoadConcurrency, threads.length)},
      (_, index) => worker(index),
    ),
  );
  return threads.flatMap((thread) => {
    const details = conversations.get(thread.id);
    return details === undefined ? [] : [details];
  });
}

export interface ReviewCommentSession {
  readonly artifactId: string | null;
  readonly annotations: readonly ReviewAnnotation[];
  readonly changeState: (thread: CommentThread) => Promise<void>;
  readonly createReply: (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ) => Promise<boolean>;
  readonly deleteReply: (reply: CommentReply) => Promise<void>;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly projectId: string;
  readonly reload: () => Promise<void>;
  readonly repliesByThread: ReadonlyMap<string, readonly CommentReply[]>;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  readonly updateUnanchored: (threadIds: readonly string[]) => void;
  readonly updateReply: (reply: CommentReply, body: string) => Promise<boolean>;
}

/** Keep one Review version's saved threads and Plannotator projections in sync. */
export function useReviewComments({
  artifactId,
  onVersionChanged,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly onVersionChanged: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}): ReviewCommentSession {
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [repliesByThread, setRepliesByThread] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const watermarkRef = useRef<string | null>(null);
  const reloadGenerationRef = useRef(0);
  const threadUpdatedAtRef = useRef<ReadonlyMap<string, string>>(new Map());
  const ownership = useCommentListOwnership();
  const active = artifactId !== null && projectId !== "" && versionId !== null;

  const reload = useCallback(async (): Promise<void> => {
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;
    if (artifactId === null || projectId === "" || versionId === null) {
      setThreads([]);
      setRepliesByThread(new Map());
      setSelectedThreadId(null);
      setUnanchoredIds([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await ownership.own(async () => {
        const listedThreads = await loadAllThreads(
          projectId,
          artifactId,
          versionId,
          null,
        );
        const conversations = await loadConversations(
          projectId,
          artifactId,
          listedThreads,
        );
        if (reloadGenerationRef.current !== generation) return;
        setThreads(conversations.map(({thread}) => thread));
        setRepliesByThread(new Map(
          conversations.map(({replies, thread}) => [thread.id, replies]),
        ));
      });
    } catch (caught) {
      if (reloadGenerationRef.current !== generation) return;
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      if (reloadGenerationRef.current === generation) setLoading(false);
    }
  }, [artifactId, ownership, projectId, versionId]);

  useEffect(() => {
    setThreads([]);
    setRepliesByThread(new Map());
    setSelectedThreadId(null);
    setUnanchoredIds([]);
    void reload();
  }, [reload]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
    threadUpdatedAtRef.current = new Map(
      threads.map((thread) => [thread.id, thread.updatedAt]),
    );
    if (
      selectedThreadId !== null
      && !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(null);
    }
  }, [selectedThreadId, threads]);

  const poll = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "" || versionId === null) return;
    const token = ownership.open();
    if (token < 0) return;
    try {
      const listedThreads = await loadAllThreads(
        projectId,
        artifactId,
        versionId,
        watermarkRef.current,
      );
      if (listedThreads.length === 0 || !ownership.settled(token)) return;
      const changedThreads = listedThreads.filter((thread) =>
        threadUpdatedAtRef.current.get(thread.id) !== thread.updatedAt
      );
      if (changedThreads.length === 0) return;
      const conversations = await loadConversations(
        projectId,
        artifactId,
        changedThreads,
      );
      if (!ownership.settled(token)) return;
      setThreads((current) => mergeThreads(
        current,
        conversations.map(({thread}) => thread),
      ));
      setRepliesByThread((current) => {
        const nextReplies = new Map(current);
        for (const conversation of conversations) {
          nextReplies.set(conversation.thread.id, conversation.replies);
        }
        return nextReplies;
      });
    } catch {
      // A failed background refresh leaves the last readable thread set intact.
    }
  }, [artifactId, ownership, projectId, versionId]);

  useCommentPoll(poll, active);

  const submit = useCallback(async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || versionId === null) return false;
    setError(null);
    try {
      const storedAnchor: CommentAnchor = z.json().parse(anchor);
      const created = await ownership.own(() =>
        api.createComment(
          projectId,
          artifactId,
          versionId,
          {anchor: storedAnchor, body, path},
          crypto.randomUUID(),
        )
      );
      if (created.thread.versionId !== versionId) {
        onVersionChanged(created.thread.versionId);
      } else {
        await reload();
        setSelectedThreadId(created.thread.id);
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment creation failed."),
      );
      return false;
    }
  }, [artifactId, onVersionChanged, ownership, projectId, reload, versionId]);

  const changeState = useCallback(async (thread: CommentThread): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() =>
        api.updateComment(projectId, artifactId, thread.id, {
          state: thread.state === "open" ? "resolved" : "open",
        })
      );
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment state change failed."),
      );
    }
  }, [artifactId, ownership, projectId, reload]);

  const createReply = useCallback(async (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || thread.state !== "open") return false;
    setError(null);
    try {
      await ownership.own(() => api.createCommentReply(
        projectId,
        artifactId,
        thread.id,
        body,
        idempotencyKey,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply creation failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const updateReply = useCallback(async (
    reply: CommentReply,
    body: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "") return false;
    setError(null);
    try {
      await ownership.own(() => api.updateCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
        body,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply edit failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const deleteReply = useCallback(async (reply: CommentReply): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() => api.deleteCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
      ));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply deletion failed."));
    }
  }, [artifactId, ownership, projectId, reload]);

  const annotations = useMemo(
    () => threads.filter((thread) => thread.state === "open").map(toAnnotation),
    [threads],
  );

  return {
    annotations,
    artifactId,
    changeState,
    createReply,
    deleteReply,
    error,
    loading,
    projectId,
    reload,
    repliesByThread,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    submit,
    threads,
    unanchoredIds,
    updateUnanchored: setUnanchoredIds,
    updateReply,
  };
}

/** The new-thread composer, drafted per artifact and version. */
function NewThreadComposer({
  artifactId,
  principalId,
  session,
  versionId,
}: {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: null,
    versionId,
  });
  return (
    <div data-new-thread-composer>
      <CommentComposer
        cancelLabel={null}
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        inputId={`review-new-thread-${versionId}`}
        key={`new-thread-${versionId}-${draft.restored ? "draft" : "empty"}`}
        label="Add a comment"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body) => {
          const saved = await session.submit(body, null, null);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel="Post comment"
      />
    </div>
  );
}

/** One thread's reply composer, drafted per thread. */
function ReplyComposer({
  artifactId,
  principalId,
  session,
  thread,
}: {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly thread: CommentThread;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: thread.id,
    versionId: null,
  });
  const [expanded, setExpanded] = useState(draft.restored);
  const [replyBody, setReplyBody] = useState(draft.initialBody);

  if (!expanded) {
    return (
      <div data-expanded="false">
        <Button
          onClick={() => setExpanded(true)}
          size="xs"
          type="button"
          variant="outline"
        >
          Reply
        </Button>
      </div>
    );
  }

  return (
    <div data-expanded="true">
      <CommentComposer
        cancelLabel="Cancel"
        draftRestored={draft.restored}
        initialBody={replyBody}
        inputId={`review-reply-${thread.id}`}
        label="Reply"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={(body) => {
          setReplyBody(body);
          draft.onBodyChange(body);
        }}
        onCancel={() => setExpanded(false)}
        onDiscardDraft={() => {
          setReplyBody("");
          draft.onDiscard();
        }}
        onSubmit={async (body, idempotencyKey) => {
          const saved = await session.createReply(thread, body, idempotencyKey);
          if (saved) {
            setReplyBody("");
            draft.onPosted();
            setExpanded(false);
          }
          return saved;
        }}
        submitLabel="Post reply"
      />
    </div>
  );
}

const commentViews = ["open", "all", "resolved", "sent"] as const;
type CommentView = (typeof commentViews)[number];

function isCommentView(value: string): value is CommentView {
  return commentViews.some((view) => view === value);
}

/** MessageAvatar is built for bottom-aligned chat bubbles; threads read top-down. */
const topAlignedAvatar =
  "min-w-0 self-start bg-transparent group-has-data-[slot=message-footer]/message:translate-y-0";

function initialsOf(name: string): string {
  const letters = name.trim().split(/\s+/u).slice(0, 2).flatMap((part) =>
    Array.from(part).slice(0, 1)
  );
  return letters.join("").toUpperCase() || "?";
}

function AuthorAvatar({name}: {readonly name: string}) {
  return (
    <Avatar size="sm">
      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}

/** Brings the annotation clicked in the preview into view in the thread list. */
function ScrollToSelectedThread({threadId}: {readonly threadId: string | null}) {
  const {scrollToMessage} = useMessageScroller();
  useEffect(() => {
    if (threadId !== null) scrollToMessage(threadId, {align: "nearest", behavior: "smooth"});
  }, [scrollToMessage, threadId]);
  return null;
}

export interface ReviewCommentsInspectorHandle {
  readonly reload: () => Promise<void>;
}

/** Review-native thread list kept beside, never over, the artifact. */
export const ReviewCommentsInspector = forwardRef<ReviewCommentsInspectorHandle, {
  readonly canDeleteAny: boolean;
  readonly canComment: boolean;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}>(function ReviewCommentsInspector({
  canDeleteAny,
  canComment,
  principalId,
  session,
  versionId,
}, ref) {
  const unanchored = new Set(session.unanchoredIds);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>("open");
  const [sentThreads, setSentThreads] = useState<readonly CommentThread[]>([]);
  const [sentReplies, setSentReplies] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [dispatchByThread, setDispatchByThread] = useState<ReadonlyMap<
    string,
    AgentDispatch
  >>(new Map());
  const [sentLoading, setSentLoading] = useState(false);
  const [sentError, setSentError] = useState<Error | null>(null);

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setAgentError(null);
    } catch (caught) {
      setAgentError(caught instanceof Error ? caught : new Error("Agent presence failed."));
    }
  }, []);

  const sentGenerationRef = useRef(0);
  const loadSent = useCallback(async (): Promise<void> => {
    const generation = sentGenerationRef.current + 1;
    sentGenerationRef.current = generation;
    if (session.artifactId === null || session.projectId === "" || versionId === null) {
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
      setSentLoading(false);
      return;
    }
    setSentLoading(true);
    setSentError(null);
    try {
      const listed = await loadAllThreads(
        session.projectId,
        session.artifactId,
        versionId,
        null,
        "only",
      );
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed),
        loadDispatchIndex(session.projectId, listed.map((thread) => thread.id)),
      ]);
      if (sentGenerationRef.current !== generation) return;
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(
        conversations.map(({replies, thread}) => [thread.id, replies]),
      ));
      setDispatchByThread(index);
    } catch (caught) {
      if (sentGenerationRef.current !== generation) return;
      setSentError(caught instanceof Error ? caught : new Error("Sent comments failed."));
    } finally {
      if (sentGenerationRef.current === generation) setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  useImperativeHandle(ref, () => ({reload: reloadDispatchSurface}), [reloadDispatchSurface]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    setSentThreads([]);
    setSentReplies(new Map());
    setDispatchByThread(new Map());
    void Promise.all([loadAgents(), loadSent()]);
  }, [loadAgents, loadSent]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(
    loadSent,
    view === "sent" && session.artifactId !== null && versionId !== null,
  );

  const openThreads = session.threads.filter((thread) => thread.state === "open");
  const resolvedThreads = session.threads.filter((thread) => thread.state === "resolved");
  const visibleThreads = view === "sent"
    ? sentThreads
    : view === "all"
      ? [...openThreads, ...resolvedThreads]
      : view === "open"
        ? openThreads
        : resolvedThreads;
  const visibleReplies = view === "sent" ? sentReplies : session.repliesByThread;
  const loadingVisible = view === "sent" ? sentLoading : session.loading;
  const now = Date.now();

  const cancelDispatch = async (dispatch: AgentDispatch): Promise<void> => {
    setSentError(null);
    try {
      await api.cancelAgentDispatch(session.projectId, dispatch.id);
      await reloadDispatchSurface();
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Cancel failed."));
    }
  };

  const onSent = async (): Promise<void> => {
    await reloadDispatchSurface();
  };

  return (
    <MessageScrollerProvider defaultScrollPosition="start">
      {dispatchUndo.element}
      <MessageScroller>
        <MessageScrollerViewport aria-label="Review comments">
          <MessageScrollerContent className="gap-3 p-3" role="presentation">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col text-xs">
                  <strong className="font-medium">Agents</strong>
                  <span className="truncate text-muted-foreground">
                    {agentPresenceSummary(agents)}
                  </span>
                </div>
                <div
                  aria-label="Agent presence"
                  className="flex shrink-0 items-center gap-1"
                  role="group"
                >
                  {agents?.map((agent) => (
                    <PresenceAvatar agent={agent} key={agent.id} now={now} />
                  ))}
                </div>
              </div>
              {agentError === null ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{agentError.message}</AlertDescription>
                </Alert>
              )}
              {canComment ? (
                <SendToAgentControl
                  agents={agents}
                  buttonSize="xs"
                  buttonVariant="default"
                  feedback={dispatchUndo.feedback}
                  label={`Send all open (${openThreads.length})…`}
                  onSent={onSent}
                  oneAgentLabel={(name) => `Send all open (${openThreads.length}) to ${name}`}
                  openCount={openThreads.length}
                  principalId={principalId}
                  projectId={session.projectId}
                  resolveBundle={() => Promise.resolve(bundleOfThreads(openThreads))}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Comments are read-only for this account or archived project.
                </p>
              )}
              {session.error === null ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{session.error.message}</AlertDescription>
                </Alert>
              )}
              {sentError === null ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{sentError.message}</AlertDescription>
                </Alert>
              )}
              <ToggleGroup
                aria-label="Comment filters"
                className="w-full"
                onValueChange={(next) => {
                  const [candidate] = next;
                  if (candidate !== undefined && isCommentView(candidate)) setView(candidate);
                }}
                size="sm"
                value={[view]}
                variant="outline"
              >
                {commentViews.map((candidate) => (
                  <ToggleGroupItem className="flex-1" key={candidate} value={candidate}>
                    {candidate === "all"
                      ? "All"
                      : candidate === "sent"
                        ? `Sent (${sentThreads.length})`
                        : `${candidate[0]?.toUpperCase()}${candidate.slice(1)}`}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {canComment && versionId !== null && session.artifactId !== null ? (
                <NewThreadComposer
                  artifactId={session.artifactId}
                  key={`${session.artifactId}-${versionId}`}
                  principalId={principalId}
                  session={session}
                  versionId={versionId}
                />
              ) : null}
            </div>
            {loadingVisible && visibleThreads.length === 0 ? (
              <div aria-busy="true" className="flex flex-col gap-3">
                <span className="sr-only" role="status">Loading comments…</span>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : null}
            {!loadingVisible && visibleThreads.length === 0 ? (
              <Empty className="flex-none border">
                <EmptyHeader>
                  <EmptyTitle>
                    {view === "all"
                      ? "No comments on this version yet."
                      : view === "sent"
                        ? "No sent comments on this version."
                        : view === "open" && resolvedThreads.length > 0
                          ? "All comments on this version are resolved."
                          : `No ${view} comments on this version.`}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : null}
            {visibleThreads.map((thread) => {
              const sentDispatch = view === "sent"
                ? dispatchByThread.get(thread.id)
                : undefined;
              const replies = visibleReplies.get(thread.id) ?? [];
              const selected = session.selectedThreadId === thread.id;
              return (
                <MessageScrollerItem key={thread.id} messageId={thread.id}>
                  <article
                    aria-current={selected ? "true" : undefined}
                    className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground transition-colors data-[selected=true]:border-ring data-[selected=true]:bg-muted/50"
                    data-selected={selected}
                  >
                    <Message>
                      <MessageAvatar className={topAlignedAvatar}>
                        <AuthorAvatar name={thread.author.displayName} />
                      </MessageAvatar>
                      <MessageContent>
                        <MessageHeader className="gap-2 px-0">
                          <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {thread.author.displayName}
                          </strong>
                          {sentDispatch === undefined
                            ? (
                              <Badge
                                className="capitalize"
                                data-state={thread.state}
                                variant={thread.state === "open" ? "outline" : "secondary"}
                              >
                                {thread.state}
                              </Badge>
                            )
                            : <DispatchStateChip state={sentDispatch.state} />}
                        </MessageHeader>
                        <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
                          {thread.body}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span>
                            Updated <time dateTime={thread.updatedAt}>
                              {formatTimestamp(thread.updatedAt)}
                            </time>
                          </span>
                          <span>
                            {thread.path === null ? "Whole version" : (
                              <>Page <code className="font-mono">{thread.path}</code></>
                            )}
                          </span>
                        </div>
                        {view !== "sent" && unanchored.has(thread.id) ? (
                          <p className="text-xs text-muted-foreground">
                            Location unavailable in this version
                          </p>
                        ) : null}
                        <MessageFooter className="flex-wrap gap-1 px-0">
                          {view === "sent" ? (
                            sentDispatch !== undefined
                              && dispatchIsCancelable(sentDispatch.state) ? (
                                <Button
                                  onClick={() => void cancelDispatch(sentDispatch)}
                                  size="xs"
                                  type="button"
                                  variant="outline"
                                >
                                  Cancel send
                                </Button>
                              ) : null
                          ) : (
                            <>
                              {canComment && thread.state === "open" ? (
                                <SendToAgentControl
                                  agents={agents}
                                  buttonSize="xs"
                                  buttonVariant="outline"
                                  feedback={dispatchUndo.feedback}
                                  label="Send…"
                                  onSent={onSent}
                                  oneAgentLabel={(name) => `Send to ${name}`}
                                  openCount={1}
                                  principalId={principalId}
                                  projectId={session.projectId}
                                  reasonDisplay="hidden"
                                  resolveBundle={() =>
                                    Promise.resolve(bundleOfThreads([thread]))}
                                />
                              ) : null}
                              {thread.path === null ? null : (
                                <Button
                                  onClick={() => session.selectThread(thread.id)}
                                  size="xs"
                                  type="button"
                                  variant="ghost"
                                >
                                  Show in page
                                </Button>
                              )}
                              {canComment ? (
                                <Button
                                  onClick={() => void session.changeState(thread)}
                                  size="xs"
                                  type="button"
                                  variant="ghost"
                                >
                                  {thread.state === "open" ? "Resolve" : "Reopen"}
                                </Button>
                              ) : null}
                            </>
                          )}
                        </MessageFooter>
                      </MessageContent>
                    </Message>
                    {replies.length === 0 ? null : (
                      <section
                        aria-label={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
                        className="flex flex-col gap-3 border-t pt-3"
                      >
                        <p className="text-xs font-medium text-muted-foreground">
                          {replies.length} {replies.length === 1 ? "reply" : "replies"}
                        </p>
                        <MessageGroup className="gap-3" role="list">
                          {replies.map((reply) => (
                            <ReviewReply
                              canDeleteAny={canDeleteAny}
                              canMutate={canComment}
                              key={reply.id}
                              onDelete={session.deleteReply}
                              onUpdate={session.updateReply}
                              principalId={principalId}
                              reply={reply}
                            />
                          ))}
                        </MessageGroup>
                      </section>
                    )}
                    {view !== "sent" && canComment && thread.state === "open"
                        && session.artifactId !== null ? (
                      <ReplyComposer
                        artifactId={session.artifactId}
                        principalId={principalId}
                        session={session}
                        thread={thread}
                      />
                    ) : null}
                  </article>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
      <ScrollToSelectedThread threadId={session.selectedThreadId} />
    </MessageScrollerProvider>
  );
});

function ReviewReply({
  canDeleteAny,
  canMutate,
  onDelete,
  onUpdate,
  principalId,
  reply,
}: {
  readonly canDeleteAny: boolean;
  readonly canMutate: boolean;
  readonly onDelete: (reply: CommentReply) => Promise<void>;
  readonly onUpdate: (reply: CommentReply, body: string) => Promise<boolean>;
  readonly principalId: string;
  readonly reply: CommentReply;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editorId = useId();
  const ownReply = reply.author.principalId === principalId;
  const remove = async (): Promise<void> => {
    setDeleting(true);
    await onDelete(reply);
    setDeleting(false);
  };
  return (
    <Message role="listitem">
      <MessageAvatar className={topAlignedAvatar}>
        <AuthorAvatar name={reply.author.displayName} />
      </MessageAvatar>
      <MessageContent className="gap-1.5">
        <MessageHeader className="flex-wrap items-baseline gap-x-2 px-0">
          <strong className="text-xs font-medium text-foreground">
            {reply.author.displayName}
          </strong>
          <time dateTime={reply.updatedAt}>{formatTimestamp(reply.updatedAt)}</time>
        </MessageHeader>
        {editing ? (
          <CommentComposer
            cancelLabel="Cancel"
            initialBody={reply.body}
            inputId={editorId}
            label="Edit reply"
            maximumCharacters={maximumCommentBodyCharacters}
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              const changed = await onUpdate(reply, body);
              if (changed) setEditing(false);
              return changed;
            }}
            submitLabel="Save reply"
          />
        ) : (
          <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
            {reply.body}
          </p>
        )}
        {!canMutate || editing || (!ownReply && !canDeleteAny) ? null : (
          <MessageFooter className="gap-1 px-0">
            {ownReply ? (
              <Button onClick={() => setEditing(true)} size="xs" type="button" variant="ghost">
                Edit
              </Button>
            ) : null}
            <Button
              disabled={deleting}
              onClick={() => void remove()}
              size="xs"
              type="button"
              variant="ghost"
            >
              {deleting ? <Spinner aria-hidden data-icon="inline-start" /> : null}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
