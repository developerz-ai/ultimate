// The simulation's effect log: a bulk row write is one effect per row, a send through the mail
// seam is an effect only once delivered, an effect is placed after the step its worker last wrote,
// a dead worker's effect is dropped, and every borrowed seam is chained and handed back.

import { afterEach, describe, expect, test } from 'bun:test';
import type { EntityBulkEvent } from '@ultimat3/core';
import { instrument, resetInstrumentation, subscribe, subscriberCount } from '@ultimat3/core';
import type { MailMessage } from '@ultimat3/mail';
import { memoryMailDriver, resetMailDriver, setMailDriver, tryMailDriver } from '@ultimat3/mail';
import { effectCounts, openEffectLog } from './job-sim-effects';

const message = (mailId: string, to: readonly string[]): MailMessage => ({
  mailId,
  to,
  subject: 's',
  html: '<p>h</p>',
  text: 'h',
  locale: 'en',
  tz: 'UTC',
});

const priorMail = tryMailDriver();
afterEach(() => {
  resetInstrumentation();
  if (priorMail === undefined) resetMailDriver();
  else setMailDriver(priorMail);
});

describe('openEffectLog', () => {
  test('a bulk write is one effect per row, beside the subscriber already listening', async () => {
    const seen: EntityBulkEvent[] = [];
    subscribe('entity.bulk', (event) => void seen.push(event.payload));
    const before = subscriberCount();
    const log = await openEffectLog({ isDead: () => false });
    try {
      instrument('entity.bulk', { entity: 'posts', op: 'delete', rows: 3 });
      expect(effectCounts(log.effects()).get('row:posts:delete')).toBe(3);
      expect(seen).toEqual([{ entity: 'posts', op: 'delete', rows: 3 }]);
    } finally {
      await log[Symbol.asyncDispose]();
    }
    expect(subscriberCount()).toBe(before);
  });

  test('a bulk write of zero rows records nothing', async () => {
    const log = await openEffectLog({ isDead: () => false });
    try {
      instrument('entity.bulk', { entity: 'posts', op: 'update', rows: 0 });
      expect(log.effects()).toEqual([]);
    } finally {
      await log[Symbol.asyncDispose]();
    }
  });

  test('a send with no mail driver installed is delivered in memory and recorded, then reset', async () => {
    resetMailDriver();
    const log = await openEffectLog({ isDead: () => false });
    try {
      const driver = tryMailDriver();
      if (driver === undefined) return expect.unreachable('the log installs a mail driver');
      await driver.send(message('receipt', ['a@x.example', 'b@x.example']));
      expect(log.effects()).toEqual([{ key: 'mail:receipt→a@x.example,b@x.example' }]);
    } finally {
      await log[Symbol.asyncDispose]();
    }
    expect(tryMailDriver()).toBeUndefined();
  });

  test('a send reaches the installed driver, which is put back on dispose', async () => {
    const outer = memoryMailDriver();
    setMailDriver(outer);
    const log = await openEffectLog({ isDead: () => false });
    try {
      expect(tryMailDriver()).not.toBe(outer);
      await tryMailDriver()?.send(message('welcome', ['c@x.example']));
      expect(outer.sent.map((one) => one.message.mailId)).toEqual(['welcome']);
      expect(log.effects().map((effect) => effect.key)).toEqual(['mail:welcome→c@x.example']);
    } finally {
      await log[Symbol.asyncDispose]();
    }
    expect(tryMailDriver()).toBe(outer);
  });

  test("an effect is placed after its worker's last step; a dead worker's is dropped", async () => {
    const dead = new Set<string>();
    const log = await openEffectLog({ isDead: (worker) => dead.has(worker) });
    try {
      log.record('before-any-step');
      log.scope.run('w1', () => {
        log.record('first');
        log.stepWritten('w1', 'charge');
        log.record('second');
      });
      log.stepWritten('w2', 'other');
      dead.add('w2');
      log.scope.run('w2', () => log.record('ghost'));
      expect(log.effects()).toEqual([
        { key: 'before-any-step' },
        { key: 'first', worker: 'w1' },
        { key: 'second', worker: 'w1', after: 'charge' },
      ]);
      log.clear();
      log.scope.run('w1', () => log.record('fresh'));
      // `clear` forgets the steps too: the next run starts with none written.
      expect(log.effects()).toEqual([{ key: 'fresh', worker: 'w1' }]);
    } finally {
      await log[Symbol.asyncDispose]();
    }
  });
});
