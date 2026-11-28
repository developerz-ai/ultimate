/**
 * The page's figures, counted up in the browser. The server already drew every tile with its final
 * number (`StatTile`'s `data-stat` paragraph); this island takes each named figure over with a
 * `CountUp` that starts from zero and ends on exactly that text. Without script, under reduced
 * motion and for a crawler the server's number is the one on screen.
 *
 * It wraps the grid and renders nothing of its own: one `CountUp` per figure, mounted INTO the
 * paragraph the tile drew. `mountOver` puts the server's text back if a render throws.
 */

import { CountUp } from '@ultimat3/effects';
import { mountOver } from '@ultimat3/render/client';
import { setSolidRuntime, UiProvider } from '@ultimat3/ui';
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

export interface HealthCountsProps {
  readonly locale: string;
  /** Final value per `data-stat` figure inside the wrapper. A stat the markup lacks is skipped. */
  readonly counts: Readonly<Record<string, number>>;
}

export function mount(el: HTMLElement, props: HealthCountsProps): () => void {
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
  return () => {
    for (const dispose of disposers) dispose();
  };
}
