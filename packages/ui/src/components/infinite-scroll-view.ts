// What the foot of an endless list shows. A rule, not markup: "loading", "there is more" and
// "that was everything" are three different announcements, and a list that shows two of them at
// once (or none) is the bug this decides away from the component.

import { invalidValueError } from '../errors';

export type LoadMoreState = 'loading' | 'more' | 'end';

export interface LoadMoreInput {
  readonly hasMore: boolean;
  readonly loading?: boolean | undefined;
  /** The next page's URL. Required while there is more, because the no-JS path is a navigation. */
  readonly nextHref?: string | undefined;
}

/**
 * Loading wins over "more": the control must not invite a second request for a page that is
 * already in flight.
 */
export function loadMoreState(input: LoadMoreInput): LoadMoreState {
  if (input.hasMore && (input.nextHref ?? '') === '') {
    throw invalidValueError(
      'InfiniteScroll',
      input.nextHref,
      'a nextHref URL whenever hasMore is true — with scripting off the control is a link, and a link needs somewhere to go',
    );
  }
  if (input.loading === true) return 'loading';
  return input.hasMore ? 'more' : 'end';
}
