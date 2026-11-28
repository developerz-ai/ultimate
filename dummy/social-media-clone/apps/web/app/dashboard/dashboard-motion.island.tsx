/**
 * The dashboard's motion, in the browser. The server drew everything — the tiles with their final
 * figures, the charts, the table, the destination cards — so with scripting off, under reduced
 * motion and for a crawler the page is complete. This island wraps it and adds three things:
 * every figure counts up (`CountUp`), the destination cards arrive one beat apart as they scroll
 * into view (`inView` + `stagger`), and friend requests waiting on the viewer enter as a notice
 * (`Presence`).
 *
 * It renders nothing of its own around the server's markup: each piece is mounted INTO a node the
 * server left (`data-stat` figures, the `data-slot="waiting"` slot) or animates one in place
 * (`data-reveal`).
 */

import { CountUp } from '@ultimat3/effects';
import { mountOver } from '@ultimat3/render/client';
import { setSolidRuntime, UiProvider } from '@ultimat3/ui';
import { inView, PRESENCE_ENTER, Presence, stagger } from '@ultimat3/ui/motion';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import styles from './page.module.scss';

export interface DashboardMotionProps {
  readonly locale: string;
  /** Final value per `data-stat` figure inside the wrapper. A stat the markup lacks is skipped. */
  readonly counts: Readonly<Record<string, number>>;
  /** Already translated: an island's props cross as JSON. Absent, nobody is waiting. */
  readonly waiting: { readonly text: string; readonly href: string } | null;
}

/**
 * The cards that enter in one tick start together, one beat apart. Returns the stops: a
 * once-watch is released only on intersection, so leaving the page first must release them.
 */
const revealCards = (cards: readonly HTMLElement[]): Array<() => void> => {
  let batch: Element[] = [];
  const flush = (): void => {
    const entered = batch;
    batch = [];
    stagger(entered, PRESENCE_ENTER, { each: 'fast', duration: 'base', easing: 'gentle' });
  };
  return cards.map((card) =>
    inView(card, () => {
      if (batch.length === 0) queueMicrotask(flush);
      batch.push(card);
      return undefined;
    }),
  );
};

export function mount(el: HTMLElement, props: DashboardMotionProps): () => void {
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  const disposers: Array<() => void> = [];
  for (const [stat, value] of Object.entries(props.counts)) {
    const figure = [...el.querySelectorAll<HTMLElement>('[data-stat]')].find(
      (node) => node.getAttribute('data-stat') === stat,
    );
    if (figure === undefined) continue;
    disposers.push(
      mountOver(figure, (root) =>
        render(
          () => (
            <UiProvider locale={props.locale}>
              <CountUp value={value} />
            </UiProvider>
          ),
          root,
        ),
      ),
    );
  }
  const slot = el.querySelector<HTMLElement>('[data-slot="waiting"]');
  const waiting = props.waiting;
  if (slot !== null && waiting !== null) {
    disposers.push(
      render(
        () => (
          <Presence when={waiting} appear duration="base" easing="snappy">
            {(notice: NonNullable<DashboardMotionProps['waiting']>) => (
              <a class={styles.notice} href={notice.href}>
                {notice.text}
              </a>
            )}
          </Presence>
        ),
        slot,
      ),
    );
  }
  disposers.push(...revealCards([...el.querySelectorAll<HTMLElement>('[data-reveal]')]));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
