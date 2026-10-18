import {type MouseEvent as ReactMouseEvent, type ReactNode, type Ref} from "react";
import {IconArrowsMinimize, IconChevronLeft, IconChevronRight, IconMessage, IconPencil, IconX} from "@tabler/icons-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import {IconButton} from "../review-primitives.tsx";

const floatingButton = "bg-background/90 shadow-lg backdrop-blur";

/** The floating full-screen controls, which can tuck away to the right edge. */
export function FocusDock({
  annotate,
  collapsed,
  commentsButtonRef,
  commentsOpen,
  download,
  hoverArmed,
  instant,
  onCollapse,
  onExit,
  onPointerLeave,
  onRestore,
  onToggleComments,
  openCommentCount,
  restoreRef,
  share,
}: {
  readonly annotate: {readonly active: boolean; readonly toggle: () => void} | null;
  readonly collapsed: boolean;
  readonly commentsButtonRef: Ref<HTMLButtonElement>;
  readonly commentsOpen: boolean;
  readonly download: ReactNode;
  readonly hoverArmed: boolean;
  readonly instant: boolean;
  readonly onCollapse: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onExit: () => void;
  readonly onPointerLeave: () => void;
  readonly onRestore: () => void;
  readonly onToggleComments: () => void;
  readonly openCommentCount: number;
  readonly restoreRef: Ref<HTMLButtonElement>;
  readonly share: ReactNode;
}) {
  return (
    <div
      className="as-focus-controls-dock"
      data-collapsed={collapsed}
      data-comments-open={commentsOpen}
      data-hover-armed={hoverArmed}
      data-instant={instant}
      onPointerLeave={onPointerLeave}
    >
      <span aria-hidden="true" className="as-focus-controls__hover-zone" />
      <div
        aria-hidden={collapsed}
        aria-label="Artifact viewer controls"
        className="as-focus-controls"
        inert={collapsed}
        role="toolbar"
      >
        {annotate === null ? null : (
          <Button
            aria-pressed={annotate.active}
            className={floatingButton}
            onClick={annotate.toggle}
            size="sm"
            title={annotate.active
              ? "Annotate mode: click an element or select text to comment. Press Escape to interact."
              : "Interact mode: links and controls work normally. Select text or turn annotation mode back on to comment."}
            variant={annotate.active ? "secondary" : "outline"}
          >
            <IconPencil data-icon="inline-start" />
            {annotate.active ? "Annotate mode" : "Interact mode"}
          </Button>
        )}
        <Button
          aria-controls="review-focus-comments"
          aria-expanded={commentsOpen}
          aria-keyshortcuts="]"
          className={floatingButton}
          onClick={onToggleComments}
          ref={commentsButtonRef}
          size="sm"
          title="Toggle comments (])"
          variant={commentsOpen ? "secondary" : "outline"}
        >
          <IconMessage data-icon="inline-start" />
          Comments
          <Badge variant="secondary">{openCommentCount}</Badge>
        </Button>
        {share}
        {download}
        <Button
          aria-keyshortcuts="F"
          className={floatingButton}
          onClick={onExit}
          size="sm"
          title="Exit full screen (F)"
          variant="outline"
        >
          <IconArrowsMinimize data-icon="inline-start" />
          Exit full screen
        </Button>
        <Button
          aria-label="Hide viewer controls"
          className={cn("as-focus-controls__collapse", floatingButton)}
          onClick={onCollapse}
          size="icon-sm"
          title="Hide viewer controls"
          variant="outline"
        >
          <IconChevronRight />
        </Button>
      </div>
      <button
        aria-hidden={!collapsed}
        aria-keyshortcuts="Meta+\\ Control+\\"
        aria-label="Show viewer controls"
        className={cn("as-focus-controls__restore rounded-l-md", floatingButton)}
        onClick={onRestore}
        ref={restoreRef}
        tabIndex={collapsed ? 0 : -1}
        title="Show viewer controls (Command/Control + \\)"
        type="button"
      >
        <IconChevronLeft aria-hidden="true" />
      </button>
    </div>
  );
}

/** The full-screen comments drawer that slides in from the right. */
export function FocusComments({
  children,
  onClose,
  open,
  openCommentCount,
}: {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly openCommentCount: number;
}) {
  return (
    <aside
      aria-hidden={!open}
      aria-labelledby="review-focus-comments-title"
      className="as-focus-comments bg-background"
      data-open={open}
      id="review-focus-comments"
      inert={!open}
    >
      <header className="flex h-12 items-center justify-between gap-2 border-b pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <IconMessage aria-hidden="true" className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium" id="review-focus-comments-title">Comments</h2>
          <Badge variant="secondary">{openCommentCount}</Badge>
        </div>
        <IconButton keyShortcuts="] Escape" label="Close comments" onClick={onClose} shortcut="]">
          <IconX />
        </IconButton>
      </header>
      <div className="min-h-0 overflow-y-auto">{children}</div>
    </aside>
  );
}
