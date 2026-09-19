// The ⌘K palette: a filter field over a list of commands and destinations, in a NON-modal
// `<dialog>` driven by its `open` attribute — never `showModal()`, so a test harness with no
// dialog methods and a server with no DOM both render it the same way. Controlled and
// presentational: the open flag, the query and the active item all live in the caller, and the
// rules (`filterItems`, `stepActive`, `keyAction`) live in `command-palette-view.ts` so the caller
// does not rewrite them. Renders closed on the server unless told otherwise; with scripting off
// it is inert markup.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { solid } from '../theme/solid-adapter';
import styles from './CommandPalette.module.scss';
import type { CommandPaletteItem } from './command-palette-view';
import { Kbd } from './Kbd';

/** Every string the palette renders, already translated. */
export interface CommandPaletteLabels {
  /** The dialog's accessible name. */
  readonly title: string;
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  /** Shown in place of the list when no item matches. */
  readonly emptyText: string;
  /** The `<Kbd>` beside the filter — "Esc" in the page's language. */
  readonly escHint: string;
}

export interface CommandPaletteProps {
  open: boolean;
  labels: CommandPaletteLabels;
  query: string;
  /** Already filtered — `filterItems(all, query)` is the caller's one line. */
  items: readonly CommandPaletteItem[];
  /** The roving selection; `settleActive`/`stepActive` keep it inside `items`. */
  activeId?: string | undefined;
  onQueryInput: (value: string) => void;
  /** The raw key event; `keyAction(event.key)` says what it means. */
  onFilterKeyDown: (event: KeyboardEvent) => void;
  onHoverItem: (id: string) => void;
  onRunItem: (id: string) => void;
  onClose: () => void;
  /** The element's id, so a trigger can name it with `aria-controls`. */
  id?: string | undefined;
  /** Refs out, so a caller can read focus or the attribute behind its own capability guard. */
  filterRef?: ((el: HTMLInputElement) => void) | undefined;
  dialogRef?: ((el: HTMLDialogElement) => void) | undefined;
  class?: string | undefined;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const rt = solid();
  let dialogEl: HTMLDialogElement | undefined;
  let filterEl: HTMLInputElement | undefined;

  // The attribute is ALSO written imperatively: a JSX-bound `open` compiles to a property
  // assignment on the client, which a fake DOM never reflects; `setAttribute` is what a browser
  // and a harness answer alike. Focus follows the write — an element under `display: none`
  // ignores `.focus()`, so it cannot be called from the caller's own open handler.
  rt.createEffect(() => {
    if (dialogEl === undefined) return;
    if (props.open) {
      dialogEl.setAttribute('open', '');
      if (filterEl !== undefined && typeof filterEl.focus === 'function') filterEl.focus();
    } else {
      dialogEl.removeAttribute('open');
    }
  });

  return (
    <dialog
      ref={(el: HTMLDialogElement) => {
        dialogEl = el;
        props.dialogRef?.(el);
      }}
      id={props.id}
      open={props.open ? true : undefined}
      class={cx(styles['palette'], props.class)}
      aria-label={props.labels.title}
      onCancel={(event: Event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class={styles['panel']}>
        <div class={styles['filterRow']}>
          <input
            ref={(el: HTMLInputElement) => {
              filterEl = el;
              props.filterRef?.(el);
            }}
            type="text"
            class={styles['filter']}
            aria-label={props.labels.filterLabel}
            placeholder={props.labels.filterPlaceholder}
            value={props.query}
            onInput={(event) => props.onQueryInput(event.currentTarget.value)}
            onKeyDown={props.onFilterKeyDown}
          />
          <Kbd>{props.labels.escHint}</Kbd>
        </div>
        {props.items.length === 0 ? (
          <p class={styles['empty']}>{props.labels.emptyText}</p>
        ) : (
          <ul class={styles['list']}>
            {props.items.map((item) => (
              <li>
                {/* A native button, never a row with a handler; roving TABINDEX, not roving focus. */}
                <button
                  type="button"
                  class={styles['item']}
                  data-active={item.id === props.activeId ? 'true' : undefined}
                  tabIndex={item.id === props.activeId ? 0 : -1}
                  onClick={() => props.onRunItem(item.id)}
                  onMouseEnter={() => props.onHoverItem(item.id)}
                  onKeyDown={props.onFilterKeyDown}
                >
                  <span class={styles['label']}>{item.label}</span>
                  {item.hint === '' ? null : <span class={styles['hint']}>{item.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
