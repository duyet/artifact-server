import {IconKeyboard} from "@tabler/icons-react";
import {Popover} from "@base-ui/react/popover";

export function reviewShortcutBlocked(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented
    || event.isComposing
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) {
    return true;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest([
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='dialog']",
    "[role='listbox']",
    "[role='menu']",
    "[role='radiogroup']",
    "[role='slider']",
    "[role='tablist']",
  ].join(", "))) {
    return true;
  }

  return document.querySelector([
    ".as-catalog-filter-popover[data-open]",
    "[data-slot='popover-content'][data-open]",
    "[role='dialog'][data-open]",
    "[role='listbox'][data-open]",
    "[role='menu'][data-open]",
  ].join(", ")) !== null;
}

export function ReviewKeyboardShortcuts() {
  return (
    <Popover.Root>
      <Popover.Trigger
        render={(
          <button
            aria-label="Keyboard shortcuts"
            className="as-keyboard-shortcuts__trigger"
            title="Keyboard shortcuts"
            type="button"
          />
        )}
      >
        <IconKeyboard aria-hidden="true" stroke={1.8} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          align="end"
          className="as-keyboard-shortcuts__positioner"
          side="top"
          sideOffset={8}
        >
          <Popover.Popup className="as-keyboard-shortcuts">
            <Popover.Title className="as-keyboard-shortcuts__title">
              Keyboard shortcuts
            </Popover.Title>
            <section aria-labelledby="review-shortcuts-navigation">
              <h3 id="review-shortcuts-navigation">Navigate</h3>
              <dl>
                <div>
                  <dt>Previous artifact</dt>
                  <dd><kbd>K</kbd><span>or</span><kbd>↑</kbd></dd>
                </div>
                <div>
                  <dt>Next artifact</dt>
                  <dd><kbd>J</kbd><span>or</span><kbd>↓</kbd></dd>
                </div>
              </dl>
            </section>
            <section aria-labelledby="review-shortcuts-layout">
              <h3 id="review-shortcuts-layout">Layout</h3>
              <dl>
                <div>
                  <dt>Artifact catalog</dt>
                  <dd><kbd>[</kbd></dd>
                </div>
                <div>
                  <dt>Inspector or comments</dt>
                  <dd><kbd>]</kbd></dd>
                </div>
                <div>
                  <dt>Full screen</dt>
                  <dd><kbd>F</kbd></dd>
                </div>
                <div>
                  <dt>Back or close current layer</dt>
                  <dd><kbd>Esc</kbd></dd>
                </div>
                <div>
                  <dt>Reveal hidden viewer controls</dt>
                  <dd><kbd>⌘ / Ctrl</kbd><span>+</span><kbd>\</kbd></dd>
                </div>
              </dl>
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

