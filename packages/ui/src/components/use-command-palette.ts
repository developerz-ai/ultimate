// The shell every `CommandPalette` caller used to write: the open flag, the query, the active row,
// `⌘K` (a row of the page's one hotkey table, so `?` lists it) and focus back to the opener on
// close. The rules stay in `command-palette-view.ts`; this file only holds the state they act on.

import { debounce } from '../debounce';
import { solid } from '../theme/solid-adapter';
import { useHotkeys } from '../use-hotkeys';
import type { CommandPaletteProps } from './CommandPalette';
import {
  type CommandPaletteItem,
  filterItems,
  keyAction,
  settleActive,
  stepActive,
} from './command-palette-view';

export interface UseCommandPaletteOptions {
  /** Every item, unfiltered; a function when the list changes over the island's life. */
  items: readonly CommandPaletteItem[] | (() => readonly CommandPaletteItem[]);
  /** The chosen item. The palette closes first, so a navigation lands on a closed palette. */
  onRun: (item: CommandPaletteItem) => void;
  /** Already-translated legend of the shortcut in `ShortcutSheet` — usually the palette's title. */
  label: string;
  /** The binding that toggles it; `mod+k` (⌘K / Ctrl K) when omitted. */
  hotkey?: string | undefined;
  /**
   * Items found for a query, for a list too long to ship: called debounced, and its answer
   * replaces `items` while the query is non-empty. A slower answer to an older query is dropped.
   */
  onQuery?: ((query: string) => Promise<readonly CommandPaletteItem[]>) | undefined;
  debounceMs?: number | undefined;
}

/** Everything `CommandPalette` takes except `labels` — spread it: `<CommandPalette {...p.props} />`. */
export type CommandPaletteState = Omit<CommandPaletteProps, 'labels' | 'class' | 'id'>;

export interface CommandPaletteController {
  readonly props: CommandPaletteState;
  readonly show: () => void;
  readonly hide: () => void;
}

export function useCommandPalette(options: UseCommandPaletteOptions): CommandPaletteController {
  const rt = solid();
  const [open, setOpen] = rt.createSignal(false);
  const [query, setQuery] = rt.createSignal('');
  const [activeId, setActiveId] = rt.createSignal<string | undefined>(undefined);
  const [found, setFound] = rt.createSignal<readonly CommandPaletteItem[]>([]);
  const [loading, setLoading] = rt.createSignal(false);
  let opener: HTMLElement | null = null;
  let asked = 0;

  const all = (): readonly CommandPaletteItem[] =>
    typeof options.items === 'function' ? options.items() : options.items;
  const visible = (): readonly CommandPaletteItem[] =>
    options.onQuery !== undefined && query().trim() !== '' ? found() : filterItems(all(), query());
  const active = (): string | undefined => settleActive(visible(), activeId());

  const ask = debounce((value: string) => {
    const onQuery = options.onQuery;
    if (onQuery === undefined) return;
    asked += 1;
    const mine = asked;
    onQuery(value).then(
      (items) => {
        if (mine !== asked) return;
        setFound(items);
        setLoading(false);
      },
      () => {
        if (mine !== asked) return;
        setFound([]);
        setLoading(false);
      },
    );
  }, options.debounceMs);
  rt.onCleanup(() => ask.cancel());

  const show = (): void => {
    if (open()) return;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    opener = typeof HTMLElement !== 'undefined' && active instanceof HTMLElement ? active : null;
    setQuery('');
    setActiveId(undefined);
    setOpen(true);
  };
  /** Forgets the request waiting or in flight: its answer, when it comes, is stale. */
  const drop = (): void => {
    ask.cancel();
    asked += 1;
    setLoading(false);
  };
  const hide = (): void => {
    if (!open()) return;
    setOpen(false);
    drop();
    const back = opener;
    opener = null;
    back?.focus();
  };
  const run = (id: string | undefined): void => {
    const item = visible().find((candidate) => candidate.id === id);
    if (item === undefined) return;
    hide();
    options.onRun(item);
  };

  useHotkeys([
    {
      keys: [options.hotkey ?? 'mod+k'],
      label: options.label,
      run: () => (open() ? hide() : show()),
    },
  ]);

  const props: CommandPaletteState = {
    get open() {
      return open();
    },
    get query() {
      return query();
    },
    get items() {
      return visible();
    },
    get activeId() {
      return active();
    },
    get loading() {
      return loading();
    },
    onQueryInput: (value) => {
      setQuery(value);
      if (options.onQuery === undefined) return;
      if (value.trim() === '') return drop();
      setLoading(true);
      ask(value);
    },
    onFilterKeyDown: (event) => {
      const action = keyAction(event.key);
      if (action === null) return;
      event.preventDefault();
      if (action === 'next' || action === 'previous') {
        setActiveId(stepActive(visible(), active(), action === 'next' ? 1 : -1));
      } else if (action === 'run') run(active());
      else hide();
    },
    onHoverItem: (id) => setActiveId(id),
    onRunItem: (id) => run(id),
    onClose: hide,
  };
  return { props, show, hide };
}
