// Single responsibility: when an endless list's sentinel asks for the next page. Kept apart from
// the observer because IntersectionObserver reports only CHANGES — a sentinel that never left the
// viewport produces no second callback, and the loading edge is the only other signal there is.

export interface LoadMoreTrigger {
  /** The observer's report: is the sentinel in view, and is a page in flight right now? */
  seen(visible: boolean, loading: boolean): void;
  /** `loading` changed. Going false with the sentinel still in view is a request of its own. */
  settled(loading: boolean): void;
}

export function createLoadMoreTrigger(onLoadMore: () => void): LoadMoreTrigger {
  let visible = false;
  return {
    seen(nowVisible, loading) {
      visible = nowVisible;
      if (visible && !loading) onLoadMore();
    },
    settled(loading) {
      // The stall this exists for: a page too short to push the sentinel out left it in view, and
      // no intersection CHANGE ever came to ask again.
      if (!loading && visible) onLoadMore();
    },
  };
}
