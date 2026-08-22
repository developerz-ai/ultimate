// The transport seam itself: the two local drivers, the "no transport configured" one, and the
// ambient slot every `send()` reads. The log driver had never been constructed by a test, and it
// is the DEFAULT for a worker with no credentials — so what it writes to the log, and what it
// deliberately does not, was unasserted.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createLogger, frozenClock } from '@ultimat3/core';
import {
  createLogDriver,
  createMemoryDriver,
  createUnconfiguredDriver,
  isMemoryDriver,
  isUnconfiguredDriver,
  type MailDriver,
  type MailMessage,
  mailDriver,
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
  UNCONFIGURED_DRIVER_NAME,
} from './driver';
import { mailIdempotencyKey, mailMessageIdToken } from './idempotency';

const message: MailMessage = {
  mailId: 'welcome',
  to: ['ada@example.test'],
  subject: 'Welcome, Ada',
  html: '<p>your one-time code is 481516</p>',
  text: 'your one-time code is 481516',
  locale: 'en',
  tz: 'UTC',
  cc: ['grace@example.test'],
  bcc: ['ops@example.test'],
};

// The ambient driver is process-global; capture whatever was installed before this file ran and
// hand it back, rather than resetting unconditionally.
const installed = tryMailDriver();

beforeEach(() => {
  resetMailDriver();
});

afterAll(() => {
  resetMailDriver();
  if (installed !== undefined) setMailDriver(installed);
});

describe('the ambient driver slot', () => {
  test('tryMailDriver answers undefined exactly where mailDriver() refuses', () => {
    expect(tryMailDriver()).toBeUndefined();
    let code = 'no-throw';
    try {
      mailDriver();
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe('X_MAIL_DRIVER_UNAVAILABLE');
  });

  test('tryMailDriver hands back the very object setMailDriver was given', () => {
    const memory = createMemoryDriver();
    setMailDriver(memory);
    // Identity, not shape: a host reads `outbox()` off this and must see the same array `send()`
    // pushed into.
    expect(tryMailDriver()).toBe(memory);
    expect(mailDriver()).toBe(memory);
    resetMailDriver();
    expect(tryMailDriver()).toBeUndefined();
  });

  test('the last setMailDriver wins — one driver per process', () => {
    const first = createMemoryDriver();
    const second = createLogDriver(createLogger({ writer: () => undefined }));
    setMailDriver(first);
    setMailDriver(second);
    expect(tryMailDriver()).toBe(second);
  });
});

describe('the log driver', () => {
  const capture = (): { lines: string[]; driver: MailDriver } => {
    const lines: string[] = [];
    return {
      lines,
      // The REAL logger with an injected writer, not a stand-in for it: redaction, level filtering
      // and field merging are core's, and a hand-written `info()` would prove none of them ran.
      driver: createLogDriver(createLogger({ level: 'info', writer: (line) => lines.push(line) })),
    };
  };

  test('writes one line per message, naming the mail and counting the recipients', async () => {
    const { lines, driver } = capture();
    await driver.send(message);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(line['msg']).toBe('mail.send');
    expect(line['mailId']).toBe('welcome');
    // A COUNT, never the list.
    expect(line['to']).toBe(1);
    expect(line['subject']).toBe('Welcome, Ada');
    expect(line['locale']).toBe('en');
    // The message-id TOKEN, which is the key DIGESTED — see the next test for why.
    expect(line['idempotencyToken']).toBe(mailMessageIdToken(message));
    expect(line['idempotencyKey']).toBeUndefined();
  });

  test('never writes the body, and never writes the cc or bcc list', async () => {
    const { lines, driver } = capture();
    await driver.send(message);
    const line = lines[0] as string;
    // The stated invariant of this file: a mail body is user data. The one-time code above is
    // there so a body that leaked is visible as a secret and not as a long string.
    expect(line).not.toContain('481516');
    expect(line).not.toContain('<p>');
    expect(line).not.toContain('your one-time code');
    // `cc` and `bcc` reach the key only through the digest, so the blind list stays blind.
    expect(line).not.toContain('grace@example.test');
    expect(line).not.toContain('ops@example.test');
    // And the primary recipient does not appear either. It used to: the line carried
    // `idempotencyKey`, and `mailIdempotencyKey` is `mail:<id>:<recipients joined>:<digest>` —
    // so the `to: <count>` field that exists to keep addresses out was followed one key later by
    // the addresses themselves. `mailMessageIdToken` is that key digested, correlates just as
    // well because it is stable per message, and was written for this exact reason.
    expect(line).not.toContain('ada@example.test');
    expect(JSON.parse(line)['idempotencyToken']).not.toContain('ada@example.test');
  });

  test('reports acceptance the same way every other transport does', async () => {
    const { driver } = capture();
    const result = await driver.send(message);
    expect(result.driver).toBe('log');
    expect(result.id).toMatch(/^log_.{12}$/);
    expect(result.queued).toBe(false);
    // `to` + `cc` + `bcc`, in that order — bcc is an envelope recipient, never a header.
    expect(result.accepted).toEqual(['ada@example.test', 'grace@example.test', 'ops@example.test']);
    // Content-derived, so two attempts at the same message report the same key.
    expect(result.idempotencyKey).toBe(mailIdempotencyKey(message));
    expect((await driver.send(message)).idempotencyKey).toBe(result.idempotencyKey);
    // …and a different message does not.
    expect((await driver.send({ ...message, subject: 'Other' })).idempotencyKey).not.toBe(
      result.idempotencyKey,
    );
  });

  test('a log driver is not a memory driver — there is no outbox to read', async () => {
    const { driver } = capture();
    await driver.send(message);
    expect(isMemoryDriver(driver)).toBe(false);
    expect(isUnconfiguredDriver(driver)).toBe(false);
  });
});

describe('the memory driver', () => {
  test('clear() empties the retained list, the outbox and lastTo together', async () => {
    const memory = createMemoryDriver();
    await memory.send(message);
    await memory.send({ ...message, mailId: 'reset', subject: 'Reset' });
    expect(memory.sent).toHaveLength(2);
    expect(memory.outbox()).toHaveLength(2);
    expect(memory.lastTo('ada@example.test')?.message.mailId).toBe('reset');

    memory.clear();

    expect(memory.sent).toHaveLength(0);
    expect(memory.outbox()).toEqual([]);
    expect(memory.lastTo('ada@example.test')).toBeUndefined();
    // The SAME array, emptied in place — `sent` is handed out by reference, so replacing it
    // would leave a host holding the old one.
    await memory.send(message);
    expect(memory.sent).toHaveLength(1);
  });

  test('outbox is newest first, which sent is not', async () => {
    const memory = createMemoryDriver();
    await memory.send({ ...message, mailId: 'first' });
    await memory.send({ ...message, mailId: 'second' });
    expect(memory.sent.map((entry) => entry.message.mailId)).toEqual(['first', 'second']);
    expect(memory.outbox().map((entry) => entry.message.mailId)).toEqual(['second', 'first']);
  });

  /**
   * `SentMail.at` is what `outbox()` and the `/_x` panel present as the send time, so it is a fact
   * a test has to be able to state. Stamped from `new Date()` it could only be observed, never
   * chosen — an assertion about ordering by time had to compare against the wall clock it was
   * racing.
   */
  test('at comes from the injected clock, not from the wall clock', async () => {
    const clock = frozenClock('2026-08-22T09:00:00.000Z');
    const memory = createMemoryDriver({ clock });
    await memory.send({ ...message, mailId: 'first' });
    clock.advance(60_000);
    await memory.send({ ...message, mailId: 'second' });
    expect(memory.sent.map((entry) => entry.at.toISOString())).toEqual([
      '2026-08-22T09:00:00.000Z',
      '2026-08-22T09:01:00.000Z',
    ]);
  });

  test('omitting the clock still stamps a real instant', async () => {
    const before = Date.now();
    const memory = createMemoryDriver();
    await memory.send(message);
    expect(memory.sent[0]?.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('the unconfigured driver', () => {
  test('rejects rather than throwing, so an awaiting caller keeps its error path', async () => {
    const driver = createUnconfiguredDriver('production');
    expect(driver.name).toBe(UNCONFIGURED_DRIVER_NAME);
    // Calling it must not throw synchronously — the method is typed as returning a promise.
    let sending: Promise<unknown> | undefined;
    expect(() => {
      sending = driver.send(message);
    }).not.toThrow();
    const error = await (sending as Promise<unknown>).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect((error as { code?: unknown }).code).toBe('X_MAIL_CREDENTIAL_MISSING');
    // The environment reaches the cause, because that is what tells an operator WHERE to set it.
    expect(String((error as { cause?: unknown }).cause)).toContain('production');
  });

  test('isUnconfiguredDriver answers true for it alone', () => {
    expect(isUnconfiguredDriver(createUnconfiguredDriver('staging'))).toBe(true);
    expect(isUnconfiguredDriver(createMemoryDriver())).toBe(false);
    expect(isUnconfiguredDriver(createLogDriver(createLogger({ writer: () => undefined })))).toBe(
      false,
    );
    // Keyed on the name, so a driver that borrows it reads as unconfigured — which is the point:
    // a host prints the boot line off this, and the name is the contract.
    const impostor: MailDriver = {
      name: UNCONFIGURED_DRIVER_NAME,
      send: () => Promise.reject(new Error('unreachable')),
    };
    expect(isUnconfiguredDriver(impostor)).toBe(true);
  });
});
