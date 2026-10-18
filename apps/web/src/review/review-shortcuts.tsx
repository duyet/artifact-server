import {Fragment} from "react";

import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Kbd, KbdGroup} from "@/components/ui/kbd";

/** Whether a single-key review shortcut must yield to typing or an open layer. */
export function reviewShortcutBlocked(event: KeyboardEvent): boolean {
  return event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || typingOrLayerBlocked(event);
}

/** Whether the command palette shortcut must yield to typing or an open layer. */
export function paletteShortcutBlocked(event: KeyboardEvent): boolean {
  return event.altKey || event.shiftKey || typingOrLayerBlocked(event);
}

/** The palette shortcut as this platform writes it. */
export function paletteShortcutHint(): string {
  return /Mac|iPhone|iPad/u.test(navigator.userAgent) ? "⌘K" : "Ctrl K";
}

function typingOrLayerBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true;

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest([
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='listbox']",
    "[role='menu']",
    "[role='radiogroup']",
    "[role='slider']",
    "[role='tablist']",
  ].join(", "))) {
    return true;
  }

  return document.querySelector([
    "[data-slot='popover-content'][data-open]",
    "[role='dialog'][data-open]",
    "[role='alertdialog'][data-open]",
    "[role='listbox'][data-open]",
    "[role='menu'][data-open]",
  ].join(", ")) !== null;
}

const shortcutGroups = [
  {
    shortcuts: [
      {keys: [["K"], ["↑"]], label: "Previous artifact"},
      {keys: [["J"], ["↓"]], label: "Next artifact"},
      {keys: [["⌘ / Ctrl", "K"]], label: "Search and commands"},
    ],
    title: "Navigate",
  },
  {
    shortcuts: [
      {keys: [["["]], label: "Sidebar"},
      {keys: [["]"]], label: "Inspector or comments"},
      {keys: [["F"]], label: "Full screen"},
      {keys: [["Esc"]], label: "Back or close current layer"},
      {keys: [["⌘ / Ctrl", "\\"]], label: "Reveal hidden viewer controls"},
    ],
    title: "Layout",
  },
] as const;

/** Every single-key shortcut the review application answers. */
export function KeyboardShortcutsDialog({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts pause while you type or a menu is open.</DialogDescription>
        </DialogHeader>
        {shortcutGroups.map((group) => (
          <section aria-label={group.title} className="flex flex-col gap-2" key={group.title}>
            <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
            <dl className="flex flex-col gap-1.5">
              {group.shortcuts.map((shortcut) => (
                <div className="flex items-center justify-between gap-4 text-sm" key={shortcut.label}>
                  <dt>{shortcut.label}</dt>
                  <dd className="flex items-center gap-1 text-xs text-muted-foreground">
                    {shortcut.keys.map((combo, index) => (
                      <Fragment key={combo.join("+")}>
                        {index === 0 ? null : <span>or</span>}
                        <KbdGroup>
                          {combo.map((key) => <Kbd key={key}>{key}</Kbd>)}
                        </KbdGroup>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
