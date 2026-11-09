// One clock: the memory mail driver built with no `clock` stamps `SentMail.at` from the installed
// clock (`installClock`), read at the send — never a clock captured when the driver was built.

import { expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { memoryMailDriver } from './driver';

test('a default-clock memory driver stamps the installed clock', async () => {
  const driver = memoryMailDriver();
  const release = installClock(frozenClock('2001-02-03T04:05:06Z'));
  try {
    await driver.send({
      mailId: 'clock.probe',
      to: ['a@example.test'],
      subject: 'probe',
      html: '<p>probe</p>',
      text: 'probe',
      locale: 'en',
    } as never);
    expect(driver.sent.at(-1)?.at.toISOString()).toBe('2001-02-03T04:05:06.000Z');
  } finally {
    release();
  }
});
