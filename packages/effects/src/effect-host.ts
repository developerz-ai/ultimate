// Everything a mount asks the browser, as one injected value: the motion port, the clock, the
// device pixel ratio, box sizes, visibility and resolved custom properties. The browser's answer is
// `browserHost()`; a test hands its own and drives 1,000 frames with no DOM at all.

import { THEME_ATTRIBUTE } from '@ultimat3/ui';
import { browserMotion, type MotionPort, observeInView } from './motion-port';

export interface EffectHost {
  readonly motion: MotionPort;
  /** Milliseconds, monotonic. */
  readonly now: () => number;
  readonly dpr: () => number;
  /** Calls back with the CSS-pixel box now and on every resize; the answer stops observing. */
  readonly observeSize: (
    el: Element,
    onSize: (width: number, height: number) => void,
  ) => () => void;
  /** Calls back with whether `el` is on screen in a visible tab; the answer stops observing. */
  readonly observeVisible: (el: Element, onVisible: (visible: boolean) => void) => () => void;
  /** Calls back when the resolved roles may have changed: a theme toggle, the OS scheme. */
  readonly observeTheme: (onChange: () => void) => () => void;
  /** A resolved custom property on `el`, `''` when unset. */
  readonly readVar: (el: Element, name: string) => string;
}

export function browserHost(): EffectHost {
  return {
    motion: browserMotion(),
    now: () => performance.now(),
    dpr: () => window.devicePixelRatio,
    observeSize: (el, onSize) => {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) onSize(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(el);
      const box = el.getBoundingClientRect();
      onSize(box.width, box.height);
      return () => observer.disconnect();
    },
    observeVisible: (el, onVisible) => {
      let onScreen = false;
      const report = (): void => onVisible(onScreen && !document.hidden);
      // `inView` is ui's one IntersectionObserver module; this adds the hidden tab beside it.
      const stopInView = observeInView(
        el,
        () => {
          onScreen = true;
          report();
          return () => {
            onScreen = false;
            report();
          };
        },
        { once: false },
      );
      document.addEventListener('visibilitychange', report);
      return () => {
        stopInView();
        document.removeEventListener('visibilitychange', report);
      };
    },
    observeTheme: (onChange) => {
      const observer = new MutationObserver(() => onChange());
      observer.observe(document.documentElement, { attributeFilter: [THEME_ATTRIBUTE] });
      const scheme = matchMedia('(prefers-color-scheme: dark)');
      scheme.addEventListener('change', onChange);
      return () => {
        observer.disconnect();
        scheme.removeEventListener('change', onChange);
      };
    },
    readVar: (el, name) => getComputedStyle(el).getPropertyValue(name).trim(),
  };
}
