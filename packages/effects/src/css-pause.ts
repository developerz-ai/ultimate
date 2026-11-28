// The pause a CSS-animated entry gets in an island: `data-effect-paused` while its root is off
// screen or the tab is hidden (`_effect.scss` holds the animation on it), and the backend label
// from `pickBackend`. No canvas, no frame loop, no shader: an entry that only animates in CSS
// carries this and nothing else.

import { type EffectBackend, pickBackend } from './backend';

export interface CssPauseEnv {
  readonly observeVisible: (el: Element, onVisible: (visible: boolean) => void) => () => void;
  readonly allowed: () => boolean;
  readonly onChange: (listener: () => void) => () => void;
}

/** Writes `data-effect-paused` while `root` should not animate; the answer stops watching. */
export function pauseOffscreen(
  root: HTMLElement,
  observeVisible: CssPauseEnv['observeVisible'],
): () => void {
  return observeVisible(root, (visible) => {
    if (visible) root.removeAttribute('data-effect-paused');
    else root.setAttribute('data-effect-paused', '');
  });
}

/** The offscreen pause plus the label (`css`, or `static` under reduced motion / a user pause). */
export function mountCssPause(
  root: HTMLElement,
  env: CssPauseEnv,
  label: (backend: EffectBackend) => void,
): () => void {
  const relabel = (): void =>
    label(
      pickBackend({
        motion: env.allowed(),
        hydrated: true,
        css: true,
        wants: 'css',
        webgl2: false,
        canvas: false,
        lost: false,
      }),
    );
  const unpause = pauseOffscreen(root, env.observeVisible);
  const unsubscribe = env.onChange(relabel);
  relabel();
  return () => {
    unpause();
    unsubscribe();
  };
}
