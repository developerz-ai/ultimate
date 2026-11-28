// The Solid shell around `mountEffect`: the backend label as a signal (the server's answer until
// the island mounts), refs for the root and the canvas, and the mount run once from an effect so a
// server render never reaches a browser API. Every animated entry's `.tsx` calls this and nothing
// else that touches the DOM.

import { solid } from '@ultimat3/ui';
import type { EffectBackend } from './backend';
import { browserHost } from './effect-host';
import { type EffectSpec, mountEffect } from './effect-mount';

export interface EffectBinding {
  readonly backend: () => EffectBackend;
  readonly root: (el: HTMLElement) => void;
  readonly canvas: (el: HTMLCanvasElement) => void;
}

export function useEffectMount(spec: EffectSpec, server: EffectBackend): EffectBinding {
  const rt = solid();
  const [backend, setBackend] = rt.createSignal<EffectBackend>(server);
  let rootEl: HTMLElement | undefined;
  let canvasEl: HTMLCanvasElement | undefined;
  rt.createEffect(() => {
    if (rootEl === undefined) return;
    rt.onCleanup(mountEffect(rootEl, canvasEl, spec, browserHost(), setBackend));
  });
  return {
    backend,
    root: (el) => {
      rootEl = el;
    },
    canvas: (el) => {
      canvasEl = el;
    },
  };
}
