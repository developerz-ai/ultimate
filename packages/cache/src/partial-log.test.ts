// `cache.invalidate.partial` during a bus outage: one refused broadcast per bust, on every
// publisher, for as long as the bus is away. Thinned to the outage's milestones, kept at WARN —
// the process is degraded and still serving — and ended by one line; the REPORT a caller gets is
// untouched, bust for bust.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type LogLevel, setLogSink } from '@ultimat3/core';
import {
  invalidateTags,
  isolateTiers,
  registerInvalidationBroadcast,
  registerTier,
  resetTiers,
} from './invalidate';
import { lruTier } from './lru';
import { INVALIDATE_PARTIAL } from './partial-log';
import { isolateDeclaredTags, resetDeclaredTags, tag } from './tags';

const restoreRegistries = [isolateTiers(), isolateDeclaredTags()];

interface Line {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}
let lines: Line[] = [];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
  resetTiers();
  resetDeclaredTags();
  lines = [];
  const previous = setLogSink((line, level) => {
    const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
    if (msg.startsWith(INVALIDATE_PARTIAL)) lines.push({ level, msg, fields });
  });
  restoreSink = () => setLogSink(previous);
});

afterEach(() => {
  restoreSink?.();
});

afterAll(() => {
  for (const restore of restoreRegistries) restore();
});

describe('cache.invalidate.partial through a bus outage', () => {
  test('20 refused busts are 5 warnings, every report still carries its error, and ONE line ends it', async () => {
    registerTier(lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 }));
    let up = false;
    registerInvalidationBroadcast(() =>
      up ? Promise.resolve() : Promise.reject(new TypeError('the bus is away')),
    );

    for (let bust = 0; bust < 20; bust += 1) {
      const report = await invalidateTags([tag('post', String(bust))]);
      expect(report.errors).toEqual([{ tier: 'broadcast', message: 'TypeError: the bus is away' }]);
    }
    expect(lines.map((line) => [line.level, line.msg, line.fields['failures']])).toEqual(
      [1, 2, 4, 8, 16].map((failures) => ['warn', INVALIDATE_PARTIAL, failures]),
    );
    // The line still carries the report it is about.
    expect(lines[0]?.fields['tags']).toEqual(['post:0']);

    // A bust that sends nothing has not asked the bus, so it ends nothing.
    await invalidateTags([]);
    expect(lines).toHaveLength(5);

    up = true;
    expect((await invalidateTags([tag('post', 'a')])).errors).toEqual([]);
    await invalidateTags([tag('post', 'b')]);
    expect(lines.slice(5)).toEqual([
      {
        level: 'info',
        msg: `${INVALIDATE_PARTIAL} recovered`,
        fields: expect.objectContaining({ tier: 'broadcast', after: 20 }),
      },
    ]);

    // The next outage is said at once.
    up = false;
    await invalidateTags([tag('post', 'c')]);
    expect(lines.at(-1)).toMatchObject({ level: 'warn', msg: INVALIDATE_PARTIAL });
    expect(lines.at(-1)?.fields['failures']).toBe(1);
  });

  test('a second tier failing during the outage is said at once: thinning is per tier', async () => {
    let redisUp = true;
    registerTier({
      ...lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 }),
      name: 'redis',
      invalidateTags: () =>
        redisUp
          ? Promise.resolve({ tier: 'redis', keys: [] })
          : Promise.reject(new TypeError('redis is away')),
    });
    registerInvalidationBroadcast(() => Promise.reject(new TypeError('the bus is away')));

    for (let bust = 0; bust < 3; bust += 1) await invalidateTags([tag('post', String(bust))]);
    expect(lines).toHaveLength(2);
    redisUp = false;
    await invalidateTags([tag('post', 'x')]);
    // The broadcast's 4th refusal and redis's 1st: one line, naming both in its errors.
    expect(lines).toHaveLength(3);
    await invalidateTags([tag('post', 'y')]);
    // The broadcast's 5th is silent; redis's 2nd is not.
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.level === 'warn')).toBe(true);
  });
});
