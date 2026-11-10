// The mail-driver suite over the two local drivers, and the proof it can fail: a driver that
// reports only `to` as accepted, and one that mints its idempotency key per attempt.

import { describe, expect, test } from 'bun:test';
import { logMailDriver, memoryMailDriver } from '@ultimat3/mail';
import type { MailDriver } from '@ultimat3/mail/adapter';
import { MAIL_DRIVER_CHECKS, mailDriverConformance } from './mail-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory mail driver'), () => {
  behavesLike(mailDriverConformance, () => memoryMailDriver());
});

describe(testName('unit', 'the log mail driver'), () => {
  behavesLike(mailDriverConformance, () => logMailDriver());
});

const check = (name: string) => {
  const found = MAIL_DRIVER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a driver that breaks the contract fails conformance'), () => {
  test('one that reports only `to` as accepted loses the blind list', async () => {
    const inner = memoryMailDriver();
    const toOnly: MailDriver = {
      name: 'memory',
      send: async (message) => ({ ...(await inner.send(message)), accepted: message.to }),
    };
    await expect(check('accepted is every envelope recipient').run(toOnly)).rejects.toThrow();
    await check('accepted is every envelope recipient').run(memoryMailDriver());
  });

  test('one that mints its key per attempt dedupes nothing', async () => {
    const inner = memoryMailDriver();
    let attempt = 0;
    const perAttempt: MailDriver = {
      name: 'memory',
      async send(message) {
        attempt += 1;
        return { ...(await inner.send(message)), idempotencyKey: `key-${attempt.toString()}` };
      },
    };
    await expect(check('the idempotency key is the content key').run(perAttempt)).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = MAIL_DRIVER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
