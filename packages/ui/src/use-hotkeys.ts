// The Solid shell over `hotkeys-view.ts`: ONE `keydown` listener per page, whatever number of
// islands register tables. Every island bundles its own copy of this module, so the listener and
// the merged table live on the document under one `Symbol.for` key, as `refresh-idle.ts` does.

import {
  type CompiledHotkeys,
  compileHotkeys,
  type HotkeyRow,
  type HotkeyState,
  type HotkeyTable,
  hotkeyAction,
} from './hotkeys-view';
import type { Accessor } from './theme/solid-adapter';
import { solid } from './theme/solid-adapter';

const SLOT: unique symbol = Symbol.for('ultimate.hotkeys');

/** Typing targets: a bare key there is text, never a shortcut. */
export const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** What the slot needs of a document; the tests hand in a fake one. */
export interface HotkeyHost {
  addEventListener(type: 'keydown', fn: (event: KeyboardEvent) => void): void;
}

interface HotkeySlot {
  readonly tables: HotkeyTable[];
  compiled: CompiledHotkeys;
  state: HotkeyState;
  readonly watchers: Set<() => void>;
}

type SlotHost = HotkeyHost & { [SLOT]?: HotkeySlot };

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const editableTarget = (target: EventTarget | null): boolean => {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === 'function' && element.closest(EDITABLE_SELECTOR) !== null;
};

/** The page's one slot over `host`, created — with its one listener — on first use. */
function slotOf(host: HotkeyHost, mac: boolean): HotkeySlot {
  const holder = host as SlotHost;
  const existing = holder[SLOT];
  if (existing !== undefined) return existing;
  const slot: HotkeySlot = {
    tables: [],
    compiled: compileHotkeys([]),
    state: { mac, pending: null, since: 0 },
    watchers: new Set(),
  };
  holder[SLOT] = slot;
  host.addEventListener('keydown', (event) => {
    const answer = hotkeyAction(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing === true,
        editable: editableTarget(event.target),
        at: event.timeStamp,
      },
      slot.state,
      slot.compiled,
    );
    slot.state = answer.state;
    if (answer.row === undefined) return;
    event.preventDefault();
    answer.row.run();
  });
  return slot;
}

const notify = (slot: HotkeySlot): void => {
  for (const watcher of [...slot.watchers]) watcher();
};

/**
 * Add a table to the page's merged one; answers the removal. A binding another table already holds
 * is `X_UI_INVALID_VALUE`, thrown here and the table left out — never two rows for one key.
 */
export function registerHotkeys(
  host: HotkeyHost,
  table: HotkeyTable,
  mac: boolean = isMac(),
): () => void {
  const slot = slotOf(host, mac);
  slot.compiled = compileHotkeys([...slot.tables, table].flat());
  slot.tables.push(table);
  notify(slot);
  return (): void => {
    const at = slot.tables.indexOf(table);
    if (at === -1) return;
    slot.tables.splice(at, 1);
    slot.compiled = compileHotkeys(slot.tables.flat());
    notify(slot);
  };
}

/** Every row registered on the page, in registration order, and whether `mod` is ⌘. */
export function hotkeyRowsOn(host: HotkeyHost): {
  readonly rows: readonly HotkeyRow[];
  readonly mac: boolean;
} {
  const slot = (host as SlotHost)[SLOT];
  return { rows: slot?.tables.flat() ?? [], mac: slot?.state.mac ?? isMac() };
}

/** Called whenever the merged table changes; answers the unsubscribe. */
export function watchHotkeys(host: HotkeyHost, fn: () => void, mac: boolean = isMac()): () => void {
  const slot = slotOf(host, mac);
  slot.watchers.add(fn);
  return (): void => {
    slot.watchers.delete(fn);
  };
}

/** Bind `table` for this component's life. Inert on the server: a shortcut needs a keyboard. */
export function useHotkeys(table: HotkeyTable): void {
  const rt = solid();
  rt.createEffect(() => {
    if (typeof document === 'undefined') return;
    rt.onCleanup(registerHotkeys(document, table));
  });
}

/** The page's merged rows, kept current — what `ShortcutSheet` lists. */
export function useHotkeyRows(): Accessor<{
  readonly rows: readonly HotkeyRow[];
  readonly mac: boolean;
}> {
  const rt = solid();
  const [rows, setRows] = rt.createSignal(hotkeyRowsOn({ addEventListener: () => {} }));
  rt.createEffect(() => {
    if (typeof document === 'undefined') return;
    const read = (): void => setRows(hotkeyRowsOn(document));
    read();
    rt.onCleanup(watchHotkeys(document, read));
  });
  return rows;
}
