// May the page move? The JS half of the two CSS guards: `reset.scss`'s `prefers-reduced-motion`
// and `_motion.scss`'s `html[data-motion="paused"]` (WCAG 2.2.2, written by `<MotionToggle>`).
// Every motion module asks here, so a script never animates what the stylesheet has stilled.

import { MOTION_STORAGE_KEY } from '@ultimat3/core/page';

/** The page, injected: the two reasons and one subscription to either changing. */
export interface MotionHost {
  reduced(): boolean;
  paused(): boolean;
  /** Called on any change of either reason; returns the unsubscribe. */
  watch(fn: () => void): () => void;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const ATTR = 'data-motion';
const PAUSED = 'paused';

type Listenable = {
  matches: boolean;
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
};

/** The real page, or `null` off the DOM — a server render has nothing to move. */
export function browserMotionHost(): MotionHost | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const media = (): Listenable | undefined =>
    typeof matchMedia === 'function' ? (matchMedia(REDUCED_MOTION_QUERY) as Listenable) : undefined;
  return {
    reduced: () => media()?.matches === true,
    paused: () => document.documentElement.getAttribute(ATTR) === PAUSED,
    watch(fn) {
      const query = media();
      query?.addEventListener?.('change', fn);
      const observer =
        typeof MutationObserver === 'function' ? new MutationObserver(() => fn()) : undefined;
      observer?.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });
      return () => {
        query?.removeEventListener?.('change', fn);
        observer?.disconnect();
      };
    },
  };
}

/** True while neither the OS asks for reduced motion nor the reader paused the page. */
export function motionAllowed(host: MotionHost | null = browserMotionHost()): boolean {
  return host !== null && !host.reduced() && !host.paused();
}

/** `fn(allowed)` on each CHANGE of `motionAllowed()`, never a repeat. Returns the unsubscribe. */
export function onMotionChange(
  fn: (allowed: boolean) => void,
  host: MotionHost | null = browserMotionHost(),
): () => void {
  if (host === null) return () => {};
  let last = motionAllowed(host);
  return host.watch(() => {
    const now = motionAllowed(host);
    if (now === last) return;
    last = now;
    fn(now);
  });
}

/** Private-mode Safari throws on storage access; a pause is never worth a crash. */
function store(write: () => void): void {
  try {
    write();
  } catch {
    // The attribute below still pauses this page; only the memory across pages is lost.
  }
}

/** Pause or resume the page: the attribute the CSS guard reads, and the stored choice. */
export function setMotionPaused(paused: boolean): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (paused) {
    html.setAttribute(ATTR, PAUSED);
    store(() => localStorage.setItem(MOTION_STORAGE_KEY, PAUSED));
  } else {
    html.removeAttribute(ATTR);
    store(() => localStorage.removeItem(MOTION_STORAGE_KEY));
  }
}

/** The stored choice: was the page paused on a previous visit? */
export function storedMotionPaused(): boolean {
  let paused = false;
  store(() => {
    const remembered = localStorage.getItem(MOTION_STORAGE_KEY);
    paused = remembered === PAUSED;
  });
  return paused;
}
