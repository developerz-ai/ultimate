// Single responsibility: what a render tells core's instrumentation bus — `render.page` around a
// route component, `render.hole` around each streamed hole fill, `render.isr.regenerate` around an
// ISR generation — each inside an internal span carrying the route PATTERN as `http.route`.

import type { InstrumentEventMap } from '@ultimat3/core';
import { instrument, SEMCONV, subscribed, withSpan } from '@ultimat3/core';
import { routePatternOfFile } from './registry';
import type { HoleSink } from './render-html';

type RenderEventName = 'render.page' | 'render.hole' | 'render.isr.regenerate';

/** The route's pattern when the file is a registered route; the file itself otherwise, never a guess. */
export function routeOfFile(file: string): string {
  return routePatternOfFile(file) ?? file;
}

/**
 * Run `work` inside a span named for the event, then publish the event with its duration — and the
 * failure, rethrown unchanged, when it threw.
 */
export async function timedRender<N extends RenderEventName, T>(
  name: N,
  fields: Omit<InstrumentEventMap[N], 'durationMs' | 'error'>,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const publish = (error?: unknown): void => {
    if (!subscribed(name)) return;
    const timed = {
      durationMs: performance.now() - started,
      ...(error === undefined ? {} : { error }),
    };
    instrument(name, { ...fields, ...timed } as InstrumentEventMap[N]);
  };
  try {
    const result = await withSpan(name, work, {
      kind: 'internal',
      attributes: { [SEMCONV.httpRoute]: fields.route },
    });
    publish();
    return result;
  } catch (error) {
    publish(error);
    throw error;
  }
}

/**
 * The caller's sink, every hole's fill timed as `render.hole`. Holes, ids and `add` stay the
 * caller's own, so the stream branch still reads the holes it handed in.
 */
export function instrumentedHoles(sink: HoleSink, route: string): HoleSink {
  return {
    get holes() {
      return sink.holes;
    },
    nextId: () => sink.nextId(),
    add: (hole) =>
      sink.add({
        ...hole,
        resolve: (signal) =>
          timedRender('render.hole', { route, hole: hole.id }, () => hole.resolve(signal)),
      }),
    enter: sink.enter,
  };
}
