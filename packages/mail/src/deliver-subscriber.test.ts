// The double-send a subscriber could cause: `deliverMail` emits `mail.deliver` INSIDE its `try`,
// so a subscriber throwing on the success event used to land in the catch — a second, failed
// event, and a rethrow the queue retried by sending the message again. The bus contains it now.

import { afterEach, expect, test } from 'bun:test';
import type { MailDeliverEvent } from '@ultimat3/core';
import { resetInstrumentation, setLogSink, subscribe, subscriberFailures } from '@ultimat3/core';
import { installMailDriver, resetMailDriver } from './adapter';
import { deliverMail } from './deliver';
import { memoryMailDriver } from './driver';

afterEach(() => {
  resetInstrumentation();
  resetMailDriver();
});

test('a subscriber that throws on success: sent once, one ok event, no throw', async () => {
  const driver = memoryMailDriver();
  installMailDriver(driver);
  const events: MailDeliverEvent[] = [];
  subscribe('mail.deliver', (event) => events.push(event.payload));
  const bug = new RangeError('subscriber bug');
  subscribe('mail.deliver', () => {
    throw bug;
  });
  const previous = setLogSink(() => undefined);
  try {
    await deliverMail({
      mailId: 'test-double-send',
      to: ['a@x.test'],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      locale: 'en',
      tz: 'UTC',
    });
  } finally {
    setLogSink(previous);
  }
  expect(driver.sent).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(events[0]?.error).toBeUndefined();
  expect(subscriberFailures()).toBe(1);
});
