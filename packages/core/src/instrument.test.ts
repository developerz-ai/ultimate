// The one bus: prefix matching on dot segments, registration order, unsubscribe, a throwing handler
// reaching the emitter, `subscribed()` false meaning no payload is ever built, and re-entrancy.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  instrument,
  resetInstrumentation,
  subscribe,
  subscribed,
  subscriberCount,
  subscriberFailures,
} from './instrument';
import { installLogSink } from './logger';

/** Every line the process logger writes, until `restore()`. */
function collectLines() {
  const lines: string[] = [];
  const releaseLogSink = installLogSink((line) => lines.push(line));
  return { read: () => lines, restore: () => releaseLogSink() };
}

import { INSTRUMENT_EVENTS } from './instrument-events';

afterEach(() => resetInstrumentation());

const decision = {
  label: 'post:publish',
  allowed: true,
  code: null,
  reason: null,
  actorId: 'u1',
  actorKind: 'user',
  orgId: null,
  surface: null,
  deciding: null,
};

describe('unit · instrument() / subscribe()', () => {
  test('an exact name hears only itself', () => {
    const heard: string[] = [];
    subscribe('entity.row', (event) => heard.push(event.name));
    instrument('entity.row', { entity: 'posts', op: 'insert', before: null, after: {} });
    instrument('entity.bulk', { entity: 'posts', op: 'delete', rows: 3 });
    expect(heard).toEqual(['entity.row']);
  });

  test('a prefix matches on dot segments, never on characters', () => {
    const heard: string[] = [];
    subscribe('entity', (event) => heard.push(event.name));
    subscribe('render.isr', (event) => heard.push(event.name));
    instrument('entity.row', { entity: 'posts', op: 'insert', before: null, after: {} });
    instrument('entity.cross_tenant', { reason: 'nightly sweep' });
    instrument('render.isr.regenerate', { route: '/p/:id', path: '/p/1', durationMs: 1 });
    instrument('render.page', { route: '/p/:id', durationMs: 1 });
    instrument('policy.decision', decision);
    expect(heard).toEqual(['entity.row', 'entity.cross_tenant', 'render.isr.regenerate']);
  });

  test('a pattern that is a character prefix but not a segment prefix hears nothing', () => {
    const heard: string[] = [];
    // Untyped on purpose: the type already refuses it, and this pins the runtime half.
    subscribe('entity.r' as 'entity', (event) => heard.push(event.name));
    instrument('entity.row', { entity: 'posts', op: 'insert', before: null, after: {} });
    expect(heard).toEqual([]);
  });

  test("'*' hears every event", () => {
    const heard: string[] = [];
    subscribe('*', (event) => heard.push(event.name));
    instrument('policy.decision', decision);
    instrument('cache.miss', { tier: 'memory', key: 'k' });
    expect(heard).toEqual(['policy.decision', 'cache.miss']);
  });

  test('handlers run in registration order and receive the payload by reference', () => {
    const order: string[] = [];
    const payload = { tier: 'memory', key: 'k' };
    subscribe('cache', () => order.push('first'));
    subscribe('cache.hit', (event) => {
      expect(event.payload).toBe(payload);
      order.push('second');
    });
    subscribe('*', () => order.push('third'));
    instrument('cache.hit', payload);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('unsubscribe stops delivery and is idempotent', () => {
    let count = 0;
    const off = subscribe('cache.hit', () => {
      count += 1;
    });
    instrument('cache.hit', { tier: 'memory', key: 'k' });
    off();
    off();
    instrument('cache.hit', { tier: 'memory', key: 'k' });
    expect(count).toBe(1);
    expect(subscriberCount()).toBe(0);
  });

  test('a throwing handler is contained: the emitter never sees it, the rest still run', () => {
    const heard: string[] = [];
    const lines = collectLines();
    const bug = new RangeError('subscriber bug');
    try {
      subscribe('db.statement', () => {
        throw bug;
      });
      subscribe('db.statement', () => heard.push('after'));
      const statement = { text: 'select 1', values: [], rows: 1, durationMs: 1 };
      expect(() => instrument('db.statement', statement)).not.toThrow();
      expect(() => instrument('db.statement', statement)).not.toThrow();
      expect(heard).toEqual(['after', 'after']);
      expect(subscriberFailures()).toBe(2);
      // Logged once per (handler, event name), counted every time.
      const failed = lines.read().filter((line) => line.includes('instrument.subscriber_failed'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('db.statement');
      expect(failed[0]).toContain('subscriber bug');
    } finally {
      lines.restore();
    }
  });

  test('an async handler that rejects is contained, never an unhandled rejection', async () => {
    const lines = collectLines();
    const bug = new RangeError('async subscriber bug');
    try {
      subscribe('cache.miss', async () => {
        await Promise.resolve();
        throw bug;
      });
      expect(() => instrument('cache.miss', { tier: 'memory', key: 'k' })).not.toThrow();
      await Bun.sleep(0);
      expect(subscriberFailures()).toBe(1);
      expect(lines.read().some((line) => line.includes('async subscriber bug'))).toBe(true);
    } finally {
      lines.restore();
    }
  });

  test('a handler unsubscribed earlier in the same dispatch is not called', () => {
    const heard: string[] = [];
    let offSecond: () => void = () => undefined;
    subscribe('cache.hit', () => {
      heard.push('first');
      offSecond();
    });
    offSecond = subscribe('cache.hit', () => heard.push('second'));
    instrument('cache.hit', { tier: 'memory', key: 'k' });
    expect(heard).toEqual(['first']);
  });

  test('subscribed() is false with nobody listening, so the payload builder never runs', () => {
    let built = 0;
    const build = () => {
      built += 1;
      return { entity: 'posts', op: 'delete' as const, rows: 1 };
    };
    if (subscribed('entity.bulk')) instrument('entity.bulk', build());
    expect(built).toBe(0);
    const off = subscribe('entity', () => undefined);
    expect(subscribed('entity.bulk')).toBe(true);
    expect(subscribed('policy.decision')).toBe(false);
    if (subscribed('entity.bulk')) instrument('entity.bulk', build());
    expect(built).toBe(1);
    off();
    expect(subscribed('entity.bulk')).toBe(false);
  });

  test('a handler re-emitting its own name is not re-delivered; other names nest', () => {
    const heard: string[] = [];
    subscribe('*', (event) => {
      heard.push(event.name);
      if (event.name === 'cache.miss') instrument('cache.hit', { tier: 'memory', key: 'k' });
      if (event.name === 'cache.hit') instrument('cache.miss', { tier: 'memory', key: 'k' });
    });
    instrument('cache.miss', { tier: 'memory', key: 'k' });
    expect(heard).toEqual(['cache.miss', 'cache.hit']);
  });

  test('a subscription added mid-dispatch hears the next event, not the current one', () => {
    const heard: string[] = [];
    subscribe('cache.hit', () => {
      subscribe('cache.hit', () => heard.push('late'));
    });
    instrument('cache.hit', { tier: 'memory', key: 'k' });
    expect(heard).toEqual([]);
    instrument('cache.hit', { tier: 'memory', key: 'k' });
    expect(heard).toEqual(['late']);
  });
});

describe('unit · the types are the name check', () => {
  test('a prefix subscriber narrows on name; a non-segment prefix does not compile', () => {
    const rows: number[] = [];
    const off = subscribe('entity', (event) => {
      if (event.name === 'entity.bulk') rows.push(event.payload.rows);
    });
    instrument('entity.bulk', { entity: 'posts', op: 'update', rows: 7 });
    off();
    // @ts-expect-error — `ent` is a character prefix, not a dot segment of any event name
    subscribe('ent', () => undefined)();
    // @ts-expect-error — a payload that is not the event's shape
    expect(() => instrument('cache.hit', { tier: 'memory' })).not.toThrow();
    expect(rows).toEqual([7]);
  });
});

describe('unit · INSTRUMENT_EVENTS', () => {
  test('every name is lowercase dot-segments and names an @ultimat3 owner', () => {
    for (const [name, spec] of Object.entries(INSTRUMENT_EVENTS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(spec.owner).toMatch(/^@ultimat3\/[a-z-]+$/);
    }
  });
});
