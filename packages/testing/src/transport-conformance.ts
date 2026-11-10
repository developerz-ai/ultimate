// The realtime `Transport` contract as shared examples: `behavesLike(transportConformance, () =>
// bus)`. The subject is a FRESH, open transport per test, closed by the suite. Delivery may be
// asynchronous (a real bus), so every "did not arrive" is proved by a later sentinel that did — one
// connection's messages arrive in order — never by waiting a while and calling silence an answer.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface TransportCheck {
  readonly name: string;
  run(transport: Transport): Promise<void>;
}

/** Real milliseconds: a bus delivers on its own socket, whatever the preload froze. */
const POLL_MS = 5;
const POLLS = 400;

const arrived = async (done: () => boolean): Promise<void> => {
  for (let poll = 0; poll < POLLS && !done(); poll += 1) await Bun.sleep(POLL_MS);
};

/** A subject root no other check, file or process on a shared server publishes under. */
const rootOf = (): string => `xconf.${Bun.randomUUIDv7().replaceAll('-', '')}`;

/**
 * Every subject a check composes, joined in one place. A `Transport` is BELOW `channel()` — that
 * declaration maps onto these raw bus subjects — so the suite has no declaration to pass, only the
 * one spelling rule: tokens joined by `.`, the wildcard a token of its own.
 */
const subjectOf = (...tokens: readonly string[]): string => tokens.join('.');

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const refusal = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => 'answered',
    (error: unknown) => error,
  );

export const TRANSPORT_CHECKS: readonly TransportCheck[] = [
  {
    name: 'a publish reaches a subscriber on its exact subject, payload byte for byte',
    async run(bus) {
      const subject = `${rootOf()}.change`;
      const payload = '{"id":"p1","title":"Grüße — 東京 🚀"}';
      const seen: string[] = [];
      await bus.subscribe(subject, (body, on) => seen.push(`${on}=${body}`));
      await bus.publish(subject, payload);
      await arrived(() => seen.length > 0);
      expect(seen).toEqual([`${subject}=${payload}`]);
    },
  },
  {
    name: '`*` matches exactly one token and `>` one or more trailing ones',
    async run(bus) {
      const root = rootOf();
      const [star, tail]: [string[], string[]] = [[], []];
      await bus.subscribe(subjectOf(root, '*'), (_body, on) => star.push(on));
      await bus.subscribe(subjectOf(root, '>'), (_body, on) => tail.push(on));
      for (const leaf of ['a', 'a.b', 'end']) await bus.publish(subjectOf(root, leaf), leaf);
      await bus.publish(root, 'the root itself matches neither');
      await arrived(() => tail.includes(`${root}.end`) && star.includes(`${root}.end`));
      expect([star, tail]).toEqual([
        [`${root}.a`, `${root}.end`],
        [`${root}.a`, `${root}.a.b`, `${root}.end`],
      ]);
    },
  },
  {
    name: 'a subscriber hears only the subjects it asked for',
    async run(bus) {
      const root = rootOf();
      const seen: string[] = [];
      await bus.subscribe(subjectOf(root, 'comments', '*'), (body) => seen.push(body));
      await bus.publish(subjectOf(root, 'posts', 'org-1'), 'wrong entity');
      await bus.publish(subjectOf(root, 'comments', 'org-1'), 'right entity');
      await arrived(() => seen.length > 0);
      expect(seen).toEqual(['right entity']);
    },
  },
  {
    name: 'every subscriber on one subject hears it, and an unsubscribed one stops hearing',
    async run(bus) {
      const subject = `${rootOf()}.fanout`;
      const [kept, dropped]: [string[], string[]] = [[], []];
      await bus.subscribe(subject, (body) => kept.push(body));
      const leaving = await bus.subscribe(subject, (body) => dropped.push(body));
      await bus.publish(subject, 'one');
      await arrived(() => kept.length === 1 && dropped.length === 1);
      leaving.unsubscribe();
      await bus.publish(subject, 'two');
      await arrived(() => kept.length === 2);
      expect([kept, dropped]).toEqual([['one', 'two'], ['one']]);
    },
  },
  {
    name: 'a subscriber that throws does not cost the others their message',
    async run(bus) {
      const subject = `${rootOf()}.faulty`;
      const seen: string[] = [];
      // A listener that cannot parse what it was sent — the throw an app's subscriber really makes.
      await bus.subscribe(subject, (body) => JSON.parse(body));
      await bus.subscribe(subject, (body) => seen.push(body));
      await bus.publish(subject, 'still delivered');
      await bus.publish(subject, 'and the next one');
      await arrived(() => seen.length === 2);
      expect(seen).toEqual(['still delivered', 'and the next one']);
    },
  },
  {
    name: 'shared: put lists a member with its value; touch answers whether it was live',
    async run(bus) {
      const key = `${rootOf()}.presence`;
      await bus.shared.put(key, 'm1', '{"actorId":"alice"}', 30_000);
      await bus.shared.put(key, 'm2', '{"actorId":"bob"}', 30_000);
      const listed = await bus.shared.entries(key);
      expect(listed.map((entry) => [entry.member, entry.value]).sort()).toEqual([
        ['m1', '{"actorId":"alice"}'],
        ['m2', '{"actorId":"bob"}'],
      ]);
      expect([
        await bus.shared.touch(key, 'm1', 30_000),
        await bus.shared.touch(key, 'ghost', 30_000),
      ]).toEqual([true, false]);
    },
  },
  {
    name: 'shared: drop removes one member, a dotted member id survives, an unknown key is empty',
    async run(bus) {
      const key = `${rootOf()}.room`;
      await bus.shared.put(key, 'socket.7', 'dotted', 30_000);
      await bus.shared.put(key, 'plain', 'kept', 30_000);
      await bus.shared.drop(key, 'plain');
      expect((await bus.shared.entries(key)).map((entry) => entry.member)).toEqual(['socket.7']);
      expect(await bus.shared.entries(`${rootOf()}.nobody`)).toEqual([]);
      await bus.shared.drop(key, 'socket.7');
      expect(await bus.shared.entries(key)).toEqual([]);
    },
  },
  {
    name: 'onReconnect hands back an unsubscribe that can be called',
    async run(bus) {
      const stop = bus.onReconnect(() => undefined);
      expect(typeof stop).toBe('function');
      stop();
    },
  },
  {
    name: 'a closed transport refuses publish and subscribe with X_TRANSPORT_UNAVAILABLE',
    async run(bus) {
      const subject = `${rootOf()}.closed`;
      await bus.close();
      expect(codeOf(await refusal(bus.publish(subject, '{}')))).toBe('X_TRANSPORT_UNAVAILABLE');
      expect(codeOf(await refusal(bus.subscribe(subject, () => undefined)))).toBe(
        'X_TRANSPORT_UNAVAILABLE',
      );
    },
  },
];

export const transportConformance: SharedExamples<Transport | Promise<Transport>> = sharedExamples(
  'a realtime transport',
  (subject) => {
    for (const check of TRANSPORT_CHECKS) {
      test(check.name, async () => {
        const bus = await subject();
        try {
          await check.run(bus);
        } finally {
          await bus.close();
        }
      });
    }
  },
);
