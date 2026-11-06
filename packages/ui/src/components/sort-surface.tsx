// The markup `SortableList` and `Board` share: keyed rows (a live tick beneath a drag keeps every
// node), a handle button carrying the keyboard and pointer gesture, and — with scripting off — a
// real form per row. One module, so the two components cannot drift on the gesture.

import type { JSX } from 'solid-js';
import { announce } from '../a11y';
import { cx } from '../cx';
import { type SortController, type SortSpeech, sortController } from '../drag/sort-controller';
import { type CanDrop, type SortGroup, type SortMove, sortPositions } from '../drag/sort-view';
import { UI_KEYS } from '../i18n-keys';
import { iconGripVertical } from '../icons/glyphs/grip-vertical';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import boardStyles from './Board.module.scss';
import { keyedRows } from './data-table-rows';
import { Icon } from './Icon';
import styles from './SortableList.module.scss';
import { bindSortRow, placeRows, type SortGeometry, sortGeometry } from './sort-pointer';

/** The form field names the no-script controls post. `null` leaves that field out. */
export interface SortFields {
  readonly id?: string | undefined;
  readonly fromGroup?: string | null | undefined;
  readonly toGroup?: string | null | undefined;
  readonly toIndex?: string | null | undefined;
}

export interface SortSurfaceGroup<T> extends SortGroup<T> {
  readonly label: string;
}

export interface SortSurfaceInput<T> {
  readonly groups: () => readonly SortSurfaceGroup<T>[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => JSX.Element;
  readonly onMove: (move: SortMove) => unknown;
  readonly canDrop?: CanDrop<T> | undefined;
  readonly action?: string | undefined;
  readonly fields?: SortFields | undefined;
  readonly layout: 'list' | 'board';
  readonly label: string;
  readonly class?: string | undefined;
}

const SPEECH = new Map<SortSpeech, string>([
  ['lift', UI_KEYS.sortLift],
  ['moved', UI_KEYS.sortMoved],
  ['dropped', UI_KEYS.sortDropped],
  ['cancelled', UI_KEYS.sortCancelled],
]);

const field = (name: string | null | undefined, fallback: string): string | null =>
  name === undefined ? fallback : name;

export function sortSurface<T>(input: SortSurfaceInput<T>): JSX.Element {
  const ui = useUi();
  const rt = solid();
  const [enhanced, setEnhanced] = rt.createSignal(false);
  // Effects never run on the server, so the no-script form is what the document carries.
  rt.createEffect(() => setEnhanced(true));
  const labelOf = (id: string): string =>
    input.groups().find((group) => group.id === id)?.label ?? id;
  const controller: SortController<T> = sortController(rt, {
    groups: input.groups,
    itemKey: input.itemKey,
    onMove: input.onMove,
    canDrop: input.canDrop,
    dir: () => ui.dir,
    groupLabel: labelOf,
    say: (what, params) => announce(ui.t(SPEECH.get(what) ?? UI_KEYS.sortMoved, params)),
  });
  const geometry: SortGeometry = sortGeometry();
  const names = input.fields ?? {};

  const hidden = (name: string | null, value: string): JSX.Element =>
    name === null ? null : <input type="hidden" name={name} value={value} />;

  /** The no-script move: Up and Down in a list, a target column in a board. */
  const fallback = (item: T, id: string): JSX.Element => {
    if (input.action === undefined) return null;
    const groups = input.groups();
    const g = groups.findIndex((group) => group.items.includes(item));
    const group = groups[g];
    if (group === undefined) return null;
    const index = group.items.indexOf(item);
    const targets = groups.filter(
      (target) => target.id === group.id || input.canDrop?.(item, target.id) !== false,
    );
    // A card no other column accepts has no move to offer.
    if (input.layout === 'board' && targets.length < 2) return null;
    const toIndex = field(names.toIndex, 'toIndex');
    return (
      <form method="post" action={input.action} class={styles['fallback']}>
        {hidden(field(names.id, 'id') ?? 'id', id)}
        {hidden(field(names.fromGroup, 'fromGroup'), group.id)}
        {input.layout === 'list' ? (
          <>
            {hidden(field(names.toGroup, 'toGroup'), group.id)}
            <button
              type="submit"
              name={toIndex ?? undefined}
              value={String(index - 1)}
              disabled={index === 0}
            >
              {ui.t(UI_KEYS.sortUp)}
            </button>
            <button
              type="submit"
              name={toIndex ?? undefined}
              value={String(index + 1)}
              disabled={index === group.items.length - 1}
            >
              {ui.t(UI_KEYS.sortDown)}
            </button>
          </>
        ) : (
          <>
            <select
              name={field(names.toGroup, 'toGroup') ?? undefined}
              aria-label={ui.t(UI_KEYS.sortTarget)}
            >
              {targets.map((target) => (
                <option value={target.id} selected={target.id === group.id}>
                  {target.label}
                </option>
              ))}
            </select>
            <button type="submit">{ui.t(UI_KEYS.sortHandle)}</button>
          </>
        )}
      </form>
    );
  };

  const rows = keyedRows<T, JSX.Element>(rt, input.itemKey, (row, id) => (
    <li
      class={styles['row']}
      data-sort-key={id}
      data-lifted={controller.lifted() === id ? 'true' : undefined}
      ref={(el: HTMLLIElement) => geometry.row(id, el)}
    >
      <button
        type="button"
        class={styles['handle']}
        aria-label={ui.t(UI_KEYS.sortHandle)}
        aria-pressed={controller.lifted() === id ? 'true' : 'false'}
        data-sort-handle={id}
        ref={(el: HTMLButtonElement) => bindSortRow(rt, geometry, controller, id, el)}
        onKeyDown={(event: KeyboardEvent) => {
          if (!controller.key(id, event)) return;
          event.preventDefault();
          geometry.refocus(id);
        }}
        onFocusOut={(event: FocusEvent) => {
          if (event.relatedTarget !== null) controller.leave(id);
        }}
      >
        <Icon glyph={iconGripVertical} size="sm" />
      </button>
      <div class={styles['body']}>{input.renderItem(row())}</div>
      {fallback(row(), id)}
    </li>
  ));

  // One memo: every column reads its slice of ONE keyed pass, so a card crossing columns keeps
  // its node. Keys are checked across every group first, naming the duplicate as the surface's.
  const groupNodes = rt.createMemo((): Map<string, JSX.Element[]> => {
    const view = controller.view();
    sortPositions(view, input.itemKey);
    const all = rows(view.flatMap((group) => group.items));
    const out = new Map<string, JSX.Element[]>();
    let at = 0;
    for (const group of view) {
      out.set(group.id, all.slice(at, at + group.items.length));
      at += group.items.length;
    }
    return out;
  });

  // Built once per group: a lift re-orders the rows INSIDE a list and never replaces the list,
  // so the lifted row's handle keeps its place in the document and a live tick touches nothing.
  const list = (id: string, label: () => string | undefined): JSX.Element => (
    <ul
      class={styles['list']}
      aria-label={label()}
      ref={(el: HTMLUListElement) => geometry.group(id, el)}
    >
      {typeof document === 'undefined' ? (groupNodes().get(id) ?? []) : null}
    </ul>
  );

  // In a browser ONE effect places every row in every list. Solid's own reconcile, run per list,
  // removes a row it no longer lists with `node.remove()` — and when the destination list ran
  // first, that detached the card it had just received. One pass only ever moves a node. A server
  // render has no effects and writes the rows as children above.
  rt.createEffect(() => {
    const nodes = groupNodes();
    for (const [id, list] of geometry.lists()) placeRows(list, nodes.get(id) ?? []);
  });

  const columns = keyedRows<SortSurfaceGroup<T>, JSX.Element>(
    rt,
    (group) => group.id,
    (group, id) => (
      // biome-ignore lint/a11y/useSemanticElements: a column is a group of the board, not a form's fieldset
      <section class={boardStyles['column']} role="group" aria-label={group().label}>
        <p class={boardStyles['columnLabel']} aria-hidden="true">
          {group().label}
        </p>
        {list(id, () => group().label)}
      </section>
    ),
  );
  // A list's one group id, read once: a list never becomes another list.
  const single =
    input.layout === 'list' ? list(input.groups()[0]?.id ?? '', () => undefined) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: the list or board as one named group, not a form's fieldset
    <div
      class={cx(styles['root'], input.layout === 'board' && boardStyles['board'], input.class)}
      data-enhanced={enhanced() ? 'true' : undefined}
      data-dragging={controller.lifted() === null ? undefined : 'true'}
      role="group"
      aria-label={input.label}
      ref={(el: HTMLDivElement) => geometry.root(el)}
    >
      {single ?? columns(input.groups())}
    </div>
  );
}
