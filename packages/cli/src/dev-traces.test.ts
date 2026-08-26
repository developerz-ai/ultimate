// The recorder is asserted against core's REAL tracer, never a hand-built `ReadableSpan`: the
// bug it exists to prevent is a CLI that assembles a shape the framework does not actually emit.
// Every span below arrives through `withSpan`, exactly as `x dev` receives them.

import { afterEach, describe, expect, test } from 'bun:test';
import type { FrozenClock, SpanContext } from '@ultimat3/core';
import { configureTelemetry, frozenClock, resetTelemetry, withSpan } from '@ultimat3/core';
import { STATEMENT_ATTRIBUTE } from '@ultimat3/db';
import { createTraceRecorder } from './dev-traces';

const install = (
  limit?: number,
): { recorder: ReturnType<typeof createTraceRecorder>; clock: FrozenClock } => {
  const recorder = createTraceRecorder(limit === undefined ? {} : { limit });
  const clock = frozenClock('2026-08-10T00:00:00.000Z');
  configureTelemetry({ exporter: recorder.exporter, clock });
  return { recorder, clock };
};

/** One request, exactly as the HTTP pipeline opens it: root span, `http.*` attributes, children. */
function request(
  clock: FrozenClock,
  facts: { id: string; method?: string; path: string; status?: number; parent?: SpanContext },
  children: readonly string[] = [],
  statements: readonly string[] = [],
): void {
  withSpan(
    `${facts.method ?? 'GET'} ${facts.path}`,
    (span) => {
      for (const name of children) {
        withSpan(name, () => {
          clock.advance(5);
        });
      }
      // Exactly the shape `@ultimat3/db`'s funnels open: `db.<verb>`, kind `client`, text under the
      // attribute that package declares. Anything else here would be a recorder tested against SQL
      // nothing actually emits — a literal third copy of the key is that bug with extra steps.
      for (const text of statements) {
        withSpan(
          'db.select',
          (statement) => {
            statement.setAttribute(STATEMENT_ATTRIBUTE, text);
            clock.advance(2);
          },
          { kind: 'client' },
        );
      }
      clock.advance(1);
      span.setAttributes({
        'http.request_id': facts.id,
        'http.method': facts.method ?? 'GET',
        'http.route': facts.path,
        'http.status_code': facts.status ?? 200,
      });
    },
    // Exactly `pipeline.ts`'s own call: `parent: correlation.parent`, which is defined whenever the
    // caller sent a `traceparent` and `undefined` when it did not.
    { kind: 'server', ...(facts.parent === undefined ? {} : { parent: facts.parent }) },
  );
}

/** A caller's span, as `parseTraceparent` hands one back off an inbound `traceparent` header. */
const inbound: SpanContext = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: 1,
};

afterEach(() => {
  resetTelemetry();
});

describe('unit · the /_x timeline source', () => {
  test('a request becomes one trace, identified by the id the pipeline stamped', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', method: 'POST', path: '/api/posts/publish', status: 201 });

    const [trace] = recorder.traces();
    expect(recorder.traces()).toHaveLength(1);
    expect(trace?.requestId).toBe('req_1');
    expect(trace?.method).toBe('POST');
    expect(trace?.path).toBe('/api/posts/publish');
    expect(trace?.status).toBe(201);
    expect(trace?.startedAt).toBe('2026-08-10T00:00:00.000Z');
  });

  test('the root anchors the flame at depth 0 and its children hang off its span id', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', path: '/feed' }, ['query.feed', 'cache.invalidate']);

    const trace = recorder.traces()[0];
    const root = trace?.spans.find((span) => span.parentId === null);
    expect(root?.kind).toBe('http');
    // Every non-root span names the root as its parent, or `flatten` renders an empty flame.
    const children = trace?.spans.filter((span) => span !== root) ?? [];
    expect(children).toHaveLength(2);
    expect(children.every((span) => span.parentId === root?.id)).toBe(true);
  });

  test('the span-name prefix is the kind, so the panel can total by subsystem', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', path: '/feed' }, [
      'query.feed',
      'cache.invalidate',
      'action.publishPost',
      'job.sendDigest',
      'render.page',
      'somethingAppSpecific',
    ]);

    const kinds = new Map(
      (recorder.traces()[0]?.spans ?? []).map((span) => [span.name, span.kind] as const),
    );
    expect(kinds.get('query.feed')).toBe('sql');
    expect(kinds.get('cache.invalidate')).toBe('cache');
    expect(kinds.get('action.publishPost')).toBe('action');
    expect(kinds.get('job.sendDigest')).toBe('job');
    expect(kinds.get('render.page')).toBe('render');
    // App code carries no prefix; it is still work the request did, not a span to drop.
    expect(kinds.get('somethingAppSpecific')).toBe('action');
  });

  test('startMs is relative to the request, so the flame starts at zero', () => {
    const { recorder, clock } = install();
    clock.advance(10_000);
    request(clock, { id: 'req_1', path: '/feed' }, ['query.feed']);

    const spans = recorder.traces()[0]?.spans ?? [];
    expect(spans[0]?.startMs).toBe(0);
    expect(spans.every((span) => span.startMs >= 0)).toBe(true);
  });

  // The bug this guards: `isHttpRoot` also required `parentSpanId === undefined`, and
  // `packages/http/src/pipeline.ts` passes `parent: correlation.parent` — so a request from an
  // instrumented client, an ingress or a service mesh had a defined parent, `spans.find` answered
  // `undefined`, and the whole trace vanished from `/_x/timeline`.
  test('a request that arrived with an inbound traceparent is still a request', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', path: '/feed', parent: inbound }, ['query.feed']);

    const [trace] = recorder.traces();
    expect(recorder.traces()).toHaveLength(1);
    expect(trace?.requestId).toBe('req_1');
    expect(trace?.path).toBe('/feed');
    // The root still anchors the flame at depth 0, whatever it arrived with.
    const root = trace?.spans.find((span) => span.parentId === null);
    expect(root?.kind).toBe('http');
    expect(trace?.spans.filter((span) => span.parentId === null)).toHaveLength(1);
  });

  test('spans that never got an http root are not reported as requests', () => {
    const { recorder, clock } = install();
    // A worker's job trace: same tracer, no request. The timeline panel would otherwise show a
    // row whose method and status were invented.
    withSpan('job.sendDigest', () => {
      clock.advance(3);
    });
    expect(recorder.traces()).toHaveLength(0);
  });

  test('the newest request is first, and the buffer is bounded by trace', () => {
    const { recorder, clock } = install(2);
    request(clock, { id: 'req_1', path: '/a' });
    clock.advance(1000);
    request(clock, { id: 'req_2', path: '/b' });
    clock.advance(1000);
    request(clock, { id: 'req_3', path: '/c' });

    const ids = recorder.traces().map((trace) => trace.requestId);
    expect(ids).toEqual(['req_3', 'req_2']);
  });

  test('a bounded buffer never drops half a request', () => {
    const { recorder, clock } = install(1);
    request(clock, { id: 'req_1', path: '/a' }, ['query.a', 'query.b']);
    clock.advance(1000);
    request(clock, { id: 'req_2', path: '/b' }, ['query.c']);

    const traces = recorder.traces();
    expect(traces).toHaveLength(1);
    // Root plus its one child: eviction is per trace id, so a surviving trace is whole.
    expect(traces[0]?.spans).toHaveLength(2);
  });

  test('reset drops the buffer, so a restarted dev server starts empty', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', path: '/a' });
    recorder.reset();
    expect(recorder.traces()).toEqual([]);
  });

  test('a repeated query keeps its own detail, which is how the N+1 is counted', () => {
    const { recorder, clock } = install();
    request(clock, { id: 'req_1', path: '/feed' }, ['query.feed', 'query.feed', 'query.author']);

    const details = (recorder.traces()[0]?.spans ?? [])
      .filter((span) => span.kind === 'sql')
      .map((span) => span.detail);
    expect(details).toEqual(['query.feed', 'query.feed', 'query.author']);
  });

  // The read loop the panel exists to name: one `query.feed`, then a statement per row. Grouping
  // on the name would count one query and see nothing; grouping on the text counts the loop.
  test('a statement is an sql span whose detail is its text, not its name', () => {
    const { recorder, clock } = install();
    request(
      clock,
      { id: 'req_1', path: '/feed' },
      ['query.feed'],
      [
        'select * from authors where id = $1',
        'select * from authors where id = $1',
        'select * from posts where org = $1',
      ],
    );

    const sqlSpans = (recorder.traces()[0]?.spans ?? []).filter((span) => span.kind === 'sql');
    expect(sqlSpans.map((span) => span.detail)).toEqual([
      'query.feed',
      'select * from authors where id = $1',
      'select * from authors where id = $1',
      'select * from posts where org = $1',
    ]);
    expect(sqlSpans.every((span) => span.name === 'db.select' || span.name === 'query.feed')).toBe(
      true,
    );
  });
});

/**
 * The retention bound, when it is not a number. `while (byTrace.size > NaN)` is false on every
 * pass, so the eviction loop never runs and this recorder — one entry per request, each holding
 * every `ReadableSpan` that request opened, and a request issuing 50k statements holds 50k of
 * them — grows for the life of the `x dev` process. The bound does not get bigger, it stops
 * existing.
 */
describe('a retention bound that is not a number is not a bound', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  test('a non-finite limit is refused when the recorder is built', () => {
    for (const limit of NOT_A_BOUND) {
      expect(() => createTraceRecorder({ limit })).toThrow('X_INVARIANT');
    }
  });

  test('a limit of 0 is refused — a recorder that retains nothing is not a recorder', () => {
    expect(() => createTraceRecorder({ limit: 0 })).toThrow('X_INVARIANT');
    expect(createTraceRecorder({ limit: 1 }).traces()).toEqual([]);
  });

  test('the limit the caller declared still evicts', () => {
    const { recorder, clock } = install(1);
    request(clock, { id: 'req_1', path: '/a' });
    clock.advance(1000);
    request(clock, { id: 'req_2', path: '/b' });
    expect(recorder.traces().map((trace) => trace.requestId)).toEqual(['req_2']);
  });
});
