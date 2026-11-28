// PresenceList's rule, pure over an injected runtime: one `createRoot` per key (as
// `data-table-rows.ts`), so a kept row keeps its DOM and bindings; a removed key is HELD in its
// place while it exits and disposed only after; a key back mid-exit reverses from where it is.

import { invalidValueError } from '../errors';
import type { Accessor, Setter } from '../theme/solid-adapter';
import type { MotionHandle } from './animate';

/** The slice of Solid the rule needs; `createRoot` gives each row an owner of its own. */
export interface PresenceRowsRuntime {
  createSignal<T>(value: T): [Accessor<T>, Setter<T>];
  createRoot<T>(fn: (dispose: () => void) => T): T;
}

interface Row<Item, Node> {
  item: Item;
  readonly set: Setter<Item>;
  readonly node: Node;
  readonly dispose: () => void;
  el: Element | undefined;
  leaving: boolean;
  run: MotionHandle | null;
  /** What `run` started as: an exit turned back still holds its first frame (`fill: 'both'`). */
  kind: 'enter' | 'exit';
}

export interface PresenceRows<Item> {
  update(items: readonly Item[]): void;
  dispose(): void;
}

/**
 * The next order with each leaving key kept right after the key it followed before (or first,
 * when it led). A run of leaving keys stays together.
 */
export function mergeOrder(
  previous: readonly string[],
  next: readonly string[],
  leaving: ReadonlySet<string>,
): string[] {
  const out = [...next];
  let anchor: string | null = null;
  for (const key of previous) {
    if (!leaving.has(key)) {
      if (out.includes(key)) anchor = key;
      continue;
    }
    if (out.includes(key)) continue;
    out.splice(anchor === null ? 0 : out.indexOf(anchor) + 1, 0, key);
    anchor = key;
  }
  return out;
}

export function presenceRows<Item, Node>(
  runtime: PresenceRowsRuntime,
  keyOf: (item: Item) => string,
  build: (item: Accessor<Item>, key: string, ref: (el: Element) => void) => Node,
  play: (el: Element, kind: 'enter' | 'exit') => MotionHandle,
  render: (nodes: readonly Node[]) => void,
  options: { readonly appear?: boolean | undefined } = {},
): PresenceRows<Item> {
  const rows = new Map<string, Row<Item, Node>>();
  let order: string[] = [];
  let first = true;
  let disposed = false;

  const draw = (): void => render(order.map((key) => (rows.get(key) as Row<Item, Node>).node));
  const start = (row: Row<Item, Node>, kind: 'enter' | 'exit', key: string): void => {
    if (row.el === undefined) return;
    const run = play(row.el, kind);
    row.run = run;
    row.kind = kind;
    void run.finished.then(() => {
      if (disposed || row.run !== run) return;
      row.run = null;
      if (!row.leaving) {
        // Back at rest after a turned-back exit: let go of the held frame.
        if (kind === 'exit') run.cancel();
        return;
      }
      row.dispose();
      rows.delete(key);
      order = order.filter((kept) => kept !== key);
      draw();
    });
  };
  const create = (item: Item, key: string): Row<Item, Node> =>
    runtime.createRoot((dispose) => {
      const [current, set] = runtime.createSignal(item);
      const row = {
        item,
        set,
        dispose,
        el: undefined,
        leaving: false,
        run: null,
        kind: 'enter',
      } as Omit<Row<Item, Node>, 'node'> & { node?: Node };
      try {
        row.node = build(current, key, (el) => {
          row.el = el;
        });
      } catch (error) {
        dispose();
        throw error;
      }
      return row as Row<Item, Node>;
    });

  return {
    update(items) {
      if (disposed) return;
      const next: string[] = [];
      const entering: [string, Row<Item, Node>][] = [];
      for (const item of items) {
        const key = keyOf(item);
        if (next.includes(key)) {
          throw invalidValueError('PresenceList key', key, 'a key unique per item');
        }
        next.push(key);
        const kept = rows.get(key);
        if (kept === undefined) {
          const made = create(item, key);
          rows.set(key, made);
          if (!first || options.appear === true) entering.push([key, made]);
          continue;
        }
        if (kept.item !== item) {
          kept.item = item;
          kept.set(item);
        }
        if (kept.leaving) {
          kept.leaving = false;
          kept.run?.reverse();
        }
      }
      const leaving = new Set<string>();
      for (const [key, row] of rows) {
        if (next.includes(key)) continue;
        leaving.add(key);
        if (row.leaving) continue;
        row.leaving = true;
        // Mid-flight (an enter, or an exit already turned back): turn the same animation again,
        // from where it is — a second exit would jump to its first frame.
        if (row.run !== null) {
          row.run.reverse();
          continue;
        }
        start(row, 'exit', key);
        // No element to animate (a server, a build with no ref): gone at once.
        if (row.run === null) {
          row.dispose();
          rows.delete(key);
          leaving.delete(key);
        }
      }
      order = mergeOrder(order, next, leaving);
      first = false;
      draw();
      for (const [key, row] of entering) start(row, 'enter', key);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const row of rows.values()) {
        row.run?.cancel();
        row.dispose();
      }
      rows.clear();
    },
  };
}
