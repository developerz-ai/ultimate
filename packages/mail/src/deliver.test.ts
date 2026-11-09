// `mail.deliver` on the bus: one event per hand-off to the transport — inline `send()` and the
// queued job alike — with a recipient COUNT and no address, and the failure the caller receives.

import { afterEach, describe, expect, test } from 'bun:test';
import type { MailDeliverEvent, ReadableSpan } from '@ultimat3/core';
import {
  alwaysOnSampler,
  configureTelemetry,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
} from '@ultimat3/core';
import type { JobRunArgs } from '@ultimat3/jobs';
import { deliverMail } from './deliver';
import type { MailDriver, MailMessage } from './driver';
import { memoryMailDriver, resetMailDriver, setMailDriver } from './driver';
import { driverUnavailable } from './errors';
import { sendMailJob } from './job';

const message: MailMessage = {
  mailId: 'test-deliver',
  to: ['a@x.test'],
  cc: ['b@x.test'],
  bcc: ['c@x.test'],
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  locale: 'en',
  tz: 'UTC',
};

function listen(): { events: MailDeliverEvent[]; spans: ReadableSpan[] } {
  const events: MailDeliverEvent[] = [];
  const spans: ReadableSpan[] = [];
  subscribe('mail.deliver', (event) => events.push(event.payload));
  subscribe('span.end', (event) => spans.push(event.payload));
  return { events, spans };
}

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
  resetMailDriver();
});

describe('unit · mail · mail.deliver', () => {
  test('a delivery is one event and one client span, counting every envelope recipient', async () => {
    configureTelemetry({ sampler: alwaysOnSampler });
    setMailDriver(memoryMailDriver());
    const seen = listen();
    await deliverMail(message);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]).toMatchObject({ transport: 'memory', recipients: 3 });
    expect(seen.events[0]?.error).toBeUndefined();
    // Addresses are personal data: they ride neither the event nor the span.
    expect(JSON.stringify(seen.events)).not.toContain('x.test');
    const span = seen.spans.find((candidate) => candidate.name === 'mail.deliver');
    expect(span?.kind).toBe('client');
    expect(JSON.stringify(span?.attributes)).not.toContain('x.test');
  });

  test('a refused delivery is still an event, carrying the error the caller receives', async () => {
    const refusal = driverUnavailable('a test transport that refuses every send');
    const broken: MailDriver = { name: 'broken', send: () => Promise.reject(refusal) };
    setMailDriver(broken);
    const seen = listen();
    await expect(deliverMail(message)).rejects.toBe(refusal);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.error).toBe(refusal);
  });

  test('the queued job hands off through the same door', async () => {
    setMailDriver(memoryMailDriver());
    const seen = listen();
    // The body reads `input` and calls `step.run` — a step that just runs is the whole seam.
    const step = { run: (_name: string, work: () => Promise<unknown>) => work() };
    await sendMailJob.run({ input: message, step } as unknown as JobRunArgs<MailMessage>);
    expect(seen.events.map((event) => event.transport)).toEqual(['memory']);
  });
});
