// Whether an element is worth animating: on screen (ui's one IntersectionObserver module, `inView`)
// AND in a visible tab. One function, used by the effect host and by the CSS-only pause.

import { inView } from '@ultimat3/ui/motion';

export function observeVisibility(el: Element, onVisible: (visible: boolean) => void): () => void {
  let onScreen = false;
  const report = (): void => onVisible(onScreen && !document.hidden);
  const stopInView = inView(
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
}
