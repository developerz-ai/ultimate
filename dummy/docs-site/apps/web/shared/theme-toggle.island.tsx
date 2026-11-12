// The theme toggle, as the one island the scaffold ships: the only module of the dashboard a
// browser downloads. Named by SPECIFIER from the page, never by import:
//   const ThemeSwitch = island({ src: '../../shared/theme-toggle.island.tsx', props: ['locale'] });
//
// The control itself is the catalog's `ThemeToggle`; this file is only the runtime it needs. It
// reads the browser on its own: the theme the boot stamped on `<html>`, then `theme.defaultMode`
// (stamped beside it), then the OS.

import { mountOver } from '@ultimat3/render/client';
import { setSolidRuntime, ThemeToggle, UiProvider } from '@ultimat3/ui';
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

export interface ThemeToggleIslandProps {
  /** The request's own locale, for the control's labels. A browser has no ambient one. */
  readonly locale: string;
}

/**
 * The one export the hydration runtime calls. `setSolidRuntime` comes FIRST and is not optional:
 * `@ultimat3/ui` imports types from solid-js and never a runtime, so the reactive graph a
 * component reaches is the one an entry registers. Seven NAMED imports, never a namespace: a
 * namespace object keeps every export of solid-js alive in the chunk. `mountOver` clears the shell
 * before `render`, which APPENDS, and puts it back if the render throws.
 */
export function mount(el: HTMLElement, props: ThemeToggleIslandProps): () => void {
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  return mountOver(el, (root) =>
    render(
      () => (
        <UiProvider locale={props.locale}>
          <ThemeToggle mode="toggle" />
        </UiProvider>
      ),
      root,
    ),
  );
}
