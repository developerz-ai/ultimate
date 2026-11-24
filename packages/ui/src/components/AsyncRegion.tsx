// The one way to render a region whose content has to arrive. Four branches, decided by
// `asyncBranch` and never by the caller: a skeleton while it loads, the error report when it
// fails, the empty state when a completed result held nothing, and the content.
//
// `empty` and `ready` are REQUIRED props, so a region that forgot what "nothing here" looks like
// is a type error rather than a review comment. `pending` is not a prop — the placeholder is
// derived from `reserve` so it cannot mismatch the loaded box. The failure renders through
// `ErrorState` (code, cause, fix: the developer's report) unless `failed` hands it to the app's own
// screen for the person in front of it, who should never read a shell command.

import { type AsyncState, finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './AsyncRegion.module.scss';
import {
  type AsyncBranch,
  asyncBranch,
  isBusyBranch,
  type ReserveBox,
  reserveBlockSize,
} from './async-branch';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

export interface AsyncRegionProps<T> {
  /** A live-query accessor, a resource, or a plain signal — narrowed to one of four shapes. */
  state: AsyncState<T>;
  /** The box the placeholder holds, and the box the loaded content lands in. Same value, once. */
  reserve: ReserveBox;
  /** The content. Called only with data a completed result actually carried. */
  ready: (data: T) => JSX.Element;
  /**
   * Required with no default: "nothing here yet" is a screen, not an oversight, and `EmptyState`
   * is one line of it — `empty={() => <EmptyState title={t('posts.none')} />}`.
   */
  empty: () => JSX.Element;
  /** Emptiness for a shape that is not a list. Defaults to `isEmptyData`. */
  isEmpty?: ((data: T) => boolean) | undefined;
  /** Passed straight to `ErrorState` on the failed branch, and to `failed` when given. */
  onRetry?: (() => void) | undefined;
  /**
   * The failed branch, when it is a person's screen and not a developer's report:
   * `failed={(error, retry) => <EmptyState title={t('feed.unavailable')} action={…} />}`. Handed
   * the error (to branch on its code) and `onRetry`. Absent: `ErrorState`.
   */
  failed?: ((error: unknown, retry: (() => void) | undefined) => JSX.Element) | undefined;
  class?: string | undefined;
}

export function AsyncRegion<T>(props: AsyncRegionProps<T>): JSX.Element {
  // `Array.from({ length: NaN })` is `[]` and `Infinity` asks for 2^53 - 1 elements, so an
  // unscreened line count is either a collapsed box reported as a healthy loading state or a bare
  // `RangeError` out of a render — the same screen `Skeleton` and `DataTable` already apply.
  const lines = (): number => finiteCount('AsyncRegion', 'reserve.lines', props.reserve.lines, 0);

  const branch = (): AsyncBranch<T> => asyncBranch(props.state, props.isEmpty);

  const content = (): JSX.Element => {
    const at = branch();
    if (at.kind === 'failed') {
      return props.failed === undefined ? (
        <ErrorState error={at.error} onRetry={props.onRetry} />
      ) : (
        props.failed(at.error, props.onRetry)
      );
    }
    if (at.kind === 'pending') {
      return <Skeleton lines={lines()} height={props.reserve.height} />;
    }
    return at.kind === 'empty' ? props.empty() : props.ready(at.data);
  };

  // Dimmed only where there is something to dim: a refetch over content the reader is looking at.
  // A pending region is already a placeholder, and fading a placeholder says nothing.
  const stale = (): boolean => branch().kind !== 'pending' && isBusyBranch(branch());

  return (
    <div
      class={cx(styles['region'], stale() && styles['stale'], props.class)}
      // The reserved box is emitted in EVERY branch, which is what makes the four the same size:
      // a skeleton, an error, an empty state and the content all land in one box, so nothing under
      // the region moves when the answer arrives.
      style={{ '--async-reserve': reserveBlockSize({ ...props.reserve, lines: lines() }) }}
      aria-busy={ariaBool(isBusyBranch(branch()))}
    >
      {content()}
    </div>
  );
}
