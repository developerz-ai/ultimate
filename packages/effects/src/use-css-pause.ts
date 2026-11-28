// The Solid shell around `mountCssPause`, for an entry that animates in CSS alone: the label as a
// signal, a ref for the root, and the pause mounted once from an effect. It reaches ui's motion
// gate and `inView` directly — never the frame loop, the canvas or the shader mount.

import { solid } from '@ultimat3/ui';
import { motionAllowed, onMotionChange } from '@ultimat3/ui/motion';
import type { EffectBackend } from './backend';
import { mountCssPause } from './css-pause';
import { observeVisibility } from './visibility';

export interface CssPauseBinding {
  readonly backend: () => EffectBackend;
  readonly root: (el: HTMLElement) => void;
}

export function useCssPause(server: EffectBackend): CssPauseBinding {
  const rt = solid();
  const [backend, setBackend] = rt.createSignal<EffectBackend>(server);
  let rootEl: HTMLElement | undefined;
  rt.createEffect(() => {
    if (rootEl === undefined) return;
    const env = {
      observeVisible: observeVisibility,
      allowed: () => motionAllowed(),
      onChange: (listener: () => void) => onMotionChange(() => listener()),
    };
    rt.onCleanup(mountCssPause(rootEl, env, setBackend));
  });
  return {
    backend,
    root: (el) => {
      rootEl = el;
    },
  };
}
