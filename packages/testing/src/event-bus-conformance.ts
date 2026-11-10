// The `EventBus` contract of `@ultimat3/jobs` as shared examples: `behavesLike(eventBusConformance,
// () => ({ bus, elapse }))`. `find` answers earliest first in `(publishedAt, id)` order, compares a
// cursor and never looks it up, and never finds an expired event. Time passes through `elapse`
// (a frozen clock advances, a database ages its rows), never the wall clock.

import { expect, test } from 'bun:test';
import type { EventBus, JobEvent } from '@ultimat3/jobs';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface EventBusSubject {
  readonly bus: EventBus;
  /** Let `ms` pass for every event: `clock.advance`, or both stamps moved back by `ms`. */
  readonly elapse: (ms: number) => void | Promise<void>;
}

export interface EventBusCheck {
  readonly name: string;
  run(subject: EventBusSubject): Promise<void>;
}

const HOUR_MS = 3_600_000;
const SHORT_TTL_MS = 5_000;
const PAST_SHORT_TTL_MS = 10_000;
/** Published back to back: on a frozen clock one millisecond, on a database a few. */
const BURST = 8;

let minted = 0;
/** An event name of this check's own, so checks sharing one table never find each other's. */
const nameOf = (): string => {
  minted += 1;
  return `conformance.event-${process.pid.toString(36)}-${minted.toString(36)}`;
};

const elapse = async (subject: EventBusSubject, ms: number): Promise<void> => {
  await subject.elapse(ms);
};

const order = (a: JobEvent, b: JobEvent): number =>
  a.publishedAt === b.publishedAt ? (a.id < b.id ? -1 : 1) : a.publishedAt - b.publishedAt;

export const EVENT_BUS_CHECKS: readonly EventBusCheck[] = [
  {
    name: 'publish answers the event it stored, stamped on the bus clock with its ttl',
    async run({ bus }) {
      const name = nameOf();
      const before = await bus.now();
      const event = await bus.publish(name, { n: 1 }, { correlationKey: 'k', ttl: HOUR_MS });
      expect([event.name, event.payload, event.correlationKey]).toEqual([name, { n: 1 }, 'k']);
      expect(event.publishedAt).toBeGreaterThanOrEqual(before);
      // The expiry may keep sub-millisecond precision the stamp drops: never less than the ttl.
      expect(event.expiresAt - event.publishedAt).toBeGreaterThanOrEqual(HOUR_MS);
      expect(event.expiresAt - event.publishedAt).toBeLessThanOrEqual(HOUR_MS + 1);
    },
  },
  {
    name: 'find matches the name and the correlation key, and answers the payload',
    async run({ bus }) {
      const [name, other] = [nameOf(), nameOf()];
      const floor = await bus.now();
      await bus.publish(other, { wrong: 'name' });
      const paid = await bus.publish(name, { order: 1 }, { correlationKey: 'order-1' });
      expect(await bus.find(name, 'order-2', floor)).toBeUndefined();
      const hit = await bus.find(name, 'order-1', floor);
      expect([hit?.id, hit?.payload, hit?.publishedAt]).toEqual([
        paid.id,
        { order: 1 },
        paid.publishedAt,
      ]);
      expect((await bus.find(name, undefined, floor))?.id).toBe(paid.id);
    },
  },
  {
    name: 'a cursor walks every event once, earliest first in (publishedAt, id) order',
    async run({ bus }) {
      const name = nameOf();
      const floor = await bus.now();
      const published: JobEvent[] = [];
      for (let n = 0; n < BURST; n += 1) published.push(await bus.publish(name, { n }));
      const expected = [...published].sort(order).map((each) => each.id);
      const walked: string[] = [];
      let hit = await bus.find(name, undefined, floor);
      while (hit !== undefined && walked.length <= BURST) {
        walked.push(hit.id);
        hit = await bus.find(name, undefined, hit.publishedAt, hit.id);
      }
      expect(walked).toEqual(expected);
    },
  },
  {
    // It was looked up: a cursor whose event had been purged excluded nothing, and an event of its
    // millisecond that came before it was handed to the wait again.
    name: 'a cursor whose event was purged still excludes what came before it',
    async run(subject) {
      const { bus } = subject;
      const name = nameOf();
      const before = await bus.publish(name, { n: 'before' }, { ttl: HOUR_MS });
      const cursor = await bus.publish(name, { n: 'cursor' }, { ttl: SHORT_TTL_MS });
      expect(order(before, cursor)).toBeLessThan(0);
      await elapse(subject, PAST_SHORT_TTL_MS);
      expect(await bus.purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await bus.find(name, undefined, cursor.publishedAt, cursor.id)).toBeUndefined();
      const after = await bus.publish(name, { n: 'after' }, { ttl: HOUR_MS });
      expect((await bus.find(name, undefined, cursor.publishedAt, cursor.id))?.id).toBe(after.id);
    },
  },
  {
    name: 'an expired event is never found, and purgeExpired deletes it',
    async run(subject) {
      const { bus } = subject;
      const name = nameOf();
      const floor = await bus.now();
      const brief = await bus.publish(name, {}, { ttl: SHORT_TTL_MS });
      expect((await bus.find(name, undefined, floor))?.id).toBe(brief.id);
      await elapse(subject, PAST_SHORT_TTL_MS);
      expect(await bus.find(name, undefined, floor)).toBeUndefined();
      expect(await bus.purgeExpired()).toBeGreaterThanOrEqual(1);
      expect((await bus.list(name)).map((each) => each.id)).not.toContain(brief.id);
    },
  },
  {
    name: 'since skips a refused event and anything stamped before the wait began',
    async run(subject) {
      const { bus } = subject;
      const name = nameOf();
      const early = await bus.publish(name, { n: 'early' });
      await elapse(subject, 1_000);
      const at = await bus.now();
      const refused = await bus.publish(name, { n: 'refused' });
      const wanted = await bus.publish(name, { n: 'wanted' });
      const since = { at, refused: [refused.id] };
      // A cursor at the epoch reaches back past `early`; only the wait's own line excludes it.
      expect((await bus.find(name, undefined, 0))?.id).toBe(early.id);
      expect((await bus.find(name, undefined, 0, undefined, undefined, since))?.id).toBe(wanted.id);
    },
  },
  {
    name: 'list(name) holds that name alone, in publish order',
    async run({ bus }) {
      const [name, other] = [nameOf(), nameOf()];
      const first = await bus.publish(name, { n: 1 });
      await bus.publish(other, { n: 2 });
      const second = await bus.publish(name, { n: 3 });
      const listed = await bus.list(name);
      expect(listed.map((each) => each.id).sort()).toEqual([first.id, second.id].sort());
      expect(listed.every((each) => each.name === name)).toBe(true);
      expect(listed.map((each) => each.publishedAt)).toEqual(
        listed.map((each) => each.publishedAt).sort((a, b) => a - b),
      );
    },
  },
];

export const eventBusConformance: SharedExamples<EventBusSubject | Promise<EventBusSubject>> =
  sharedExamples('an event bus', (subject) => {
    for (const check of EVENT_BUS_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
