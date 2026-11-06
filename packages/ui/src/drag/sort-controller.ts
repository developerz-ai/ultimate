// The one reorder state machine `SortableList` and `Board` share: a lifted item and where it sits,
// the preview it makes of the caller's groups, keyboard and pointer input, and the drop as a
// REQUEST — the preview holds until `onMove` settles, and a refusal puts it back and says so.

import type { Direction } from '@ultimat3/core';
import type { Accessor, Setter } from '../theme/solid-adapter';
import type { DragHandlers, DragPoint } from './pointer-drag';
import {
  type AxisBox,
  type AxisSpan,
  type CanDrop,
  dropMove,
  moveBetween,
  pointerGroup,
  pointerIndex,
  type SortGroup,
  type SortMove,
  type SortPosition,
  sortKeyStep,
  sortPositions,
  sortSpeech,
} from './sort-view';

/** The four things said aloud, each taking `{ position, total, group }`. */
export type SortSpeech = 'lift' | 'moved' | 'dropped' | 'cancelled';

export interface SortControllerInput<T> {
  readonly groups: () => readonly SortGroup<T>[];
  readonly itemKey: (item: T) => string;
  readonly onMove: (move: SortMove) => unknown;
  readonly canDrop?: CanDrop<T> | undefined;
  readonly dir: () => Direction;
  /** Text for one announcement; the component reads its catalog, a test reads a literal. */
  readonly say: (what: SortSpeech, params: ReturnType<typeof sortSpeech>) => void;
  readonly groupLabel: (id: string) => string;
}

/** Geometry the pointer path reads: the groups along the inline axis, items along the block. */
export interface SortMeasure {
  groupBoxes(): readonly AxisBox[];
  itemSpans(group: number, without: string): readonly AxisSpan[];
}

export interface SortRuntime {
  createSignal<T>(value: T): [Accessor<T>, Setter<T>];
}

interface Held {
  readonly id: string;
  readonly at: SortPosition;
}

export interface SortController<T> {
  /** The caller's groups, with a lifted or in-flight item shown where it is headed. */
  view(): readonly SortGroup<T>[];
  lifted(): string | null;
  /** True for a key the handle consumed — the component then prevents its default. */
  key(id: string, event: { key: string; altKey: boolean }): boolean;
  pointer(id: string, measure: SortMeasure): DragHandlers;
  /** Tab left the lifted handle: put it back. */
  leave(id: string): void;
}

export function sortController<T>(
  rt: SortRuntime,
  input: SortControllerInput<T>,
): SortController<T> {
  const [lift, setLift] = rt.createSignal<Held | null>(null);
  const [held, setHeld] = rt.createSignal<Held | null>(null);

  const origin = (id: string): SortPosition | undefined =>
    sortPositions(input.groups(), input.itemKey).get(id);
  const accepts =
    (id: string) =>
    (group: string): boolean => {
      const at = origin(id);
      const item = at === undefined ? undefined : input.groups()[at.group]?.items[at.index];
      if (item === undefined || input.canDrop === undefined) return true;
      return input.groups()[at?.group ?? -1]?.id === group || input.canDrop(item, group);
    };
  const view = (): readonly SortGroup<T>[] => {
    const groups = input.groups();
    const moving = lift() ?? held();
    const from = moving === null ? undefined : origin(moving.id);
    return moving === null || from === undefined ? groups : moveBetween(groups, from, moving.at);
  };
  const say = (what: SortSpeech, at: SortPosition): void =>
    input.say(what, sortSpeech(view(), at, input.groupLabel));

  const start = (id: string): void => {
    const at = origin(id);
    if (at === undefined) return;
    setLift({ id, at });
    say('lift', at);
  };
  const moveTo = (id: string, at: SortPosition, speak: boolean): void => {
    setLift({ id, at });
    if (speak) say('moved', at);
  };
  const cancel = (): void => {
    const was = lift();
    setLift(null);
    const at = was === null ? undefined : origin(was.id);
    if (at !== undefined) say('cancelled', at);
  };
  const drop = (): void => {
    const was = lift();
    if (was === null) return;
    const from = origin(was.id);
    const item = from === undefined ? undefined : input.groups()[from.group]?.items[from.index];
    const move =
      from === undefined || item === undefined
        ? null
        : dropMove(input.groups(), item, was.id, from, was.at, input.canDrop);
    if (move === null || from === undefined) {
      setLift(null);
      if (from !== undefined) say('cancelled', from);
      return;
    }
    // Held, not committed: the preview stays until the caller's answer, so a row does not jump
    // back and forward again while its server echo is in flight.
    setHeld(was);
    setLift(null);
    say('dropped', was.at);
    Promise.resolve()
      .then(() => input.onMove(move))
      .then(
        () => setHeld(null),
        () => {
          setHeld(null);
          const back = origin(was.id);
          if (back !== undefined) say('cancelled', back);
        },
      );
  };

  return {
    view,
    lifted: () => lift()?.id ?? null,
    key(id, event) {
      const current = lift();
      if (current === null) {
        if (event.key === ' ' || event.key === 'Enter') {
          start(id);
          return true;
        }
        if (!event.altKey) return false;
        const at = origin(id);
        const step =
          at === undefined
            ? null
            : sortKeyStep(input.groups(), at, event.key, input.dir(), accepts(id));
        if (step === null) return false;
        setLift({ id, at: step });
        drop();
        return true;
      }
      if (current.id !== id) return false;
      if (event.key === 'Escape') cancel();
      else if (event.key === ' ' || event.key === 'Enter') drop();
      else {
        const step = sortKeyStep(view(), current.at, event.key, input.dir(), accepts(id));
        if (step === null) return event.key.startsWith('Arrow');
        moveTo(id, step, true);
      }
      return true;
    },
    pointer(id, measure): DragHandlers {
      return {
        start: () => start(id),
        move: (point: DragPoint) => {
          const current = lift();
          if (current === null) return;
          const boxes = measure.groupBoxes();
          const near = boxes.length > 1 ? pointerGroup(point, boxes) : 0;
          const group = accepts(id)(view()[near]?.id ?? '') ? near : current.at.group;
          const index = pointerIndex(point.y, measure.itemSpans(group, id));
          if (group !== current.at.group || index !== current.at.index) {
            moveTo(id, { group, index }, false);
          }
        },
        drop: () => drop(),
        cancel: () => cancel(),
      };
    },
    leave(id) {
      if (lift()?.id === id) cancel();
    },
  };
}
