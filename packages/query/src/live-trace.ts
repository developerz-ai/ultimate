// Single responsibility: the span a LIVE read runs in, continued from the subscriber's own
// `traceparent`. The snapshot answers the subscribe, so it is that trace's child; a re-run answers
// a change, not a request, so it LINKS to the subscriber and parents on whatever caused it.

import { parseTraceparent, withSpan } from '@ultimat3/core';

/** Which read: the one a subscribe asked for, or one a change fanned out. */
export type LiveReadPhase = 'snapshot' | 'rerun';

/**
 * Runs `read` inside `live.<phase> <query>`. `traceparent` is the value the client put on its
 * `subscribe` frame; an invalid or absent one is IGNORED, as an unknown time zone is: a garbage
 * header must cost the subscriber its trace, never its subscription.
 */
export function traceLiveRead<T>(
  query: string,
  phase: LiveReadPhase,
  traceparent: string | null | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const subscriber = parseTraceparent(traceparent);
  const name = `live.${phase} ${query}`;
  const attributes = { 'ultimate.primitive': 'query', 'ultimate.query': query };
  if (phase === 'snapshot') {
    return withSpan(name, read, {
      kind: 'server',
      attributes,
      ...(subscriber === undefined ? {} : { parent: subscriber }),
    });
  }
  return withSpan(name, read, {
    kind: 'internal',
    attributes,
    links: subscriber === undefined ? [] : [subscriber],
  });
}
