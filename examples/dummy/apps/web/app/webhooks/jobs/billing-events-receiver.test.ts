// billingEventsReceiver, unit: the vendor's bytes through the real pipeline on the in-memory queue.
// What is worth failing on is Postly's half — the secret list, the event read out of the SIGNED
// body and the code that replaces a parser message — never the framework's route, which
// `@ultimat3/jobs` pins itself.
import { hmac } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { describe, expect, test, testName } from '@ultimat3/testing';
import {
  BILLING_EVENTS_PATH,
  BILLING_SIGNATURE_HEADER,
  billingEventsReceiver,
} from './billing-events-receiver';

const SECRET = 'whsec_billing_unit';

/** The vendor's rotation: the live secret first, the retired one still accepted beside it. */
const withSecrets = async (secrets: string, run: () => Promise<void>): Promise<void> => {
  const before = Bun.env['BILLING_WEBHOOK_SECRET'];
  Bun.env['BILLING_WEBHOOK_SECRET'] = secrets;
  try {
    await run();
  } finally {
    if (before === undefined) delete Bun.env['BILLING_WEBHOOK_SECRET'];
    else Bun.env['BILLING_WEBHOOK_SECRET'] = before;
  }
};

const sign = (body: string, secret = SECRET): string =>
  `sha256=${hmac('sha256', secret, body, 'hex')}`;

const deliver = (body: string, signature: string): Promise<Response> =>
  httpPipeline({
    table: httpRouter(billingEventsReceiver.routes()),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  }).handle(
    new Request(`http://localhost${BILLING_EVENTS_PATH}`, {
      method: 'POST',
      headers: { [BILLING_SIGNATURE_HEADER]: signature },
      body,
    }),
    { role: 'web' },
  );

describe(testName('unit', 'billingEventsReceiver'), () => {
  test('an event signed under the retired secret is queued, then handled from its payload', ({
    runJobs,
  }) =>
    withSecrets(`${SECRET},whsec_retired`, async () => {
      const body = '{"id":"evt_unit","type":"invoice.paid","invoice":"in_unit"}';
      const response = await deliver(body, sign(body, 'whsec_retired'));
      expect(await response.json()).toEqual({ ok: true, eventId: 'evt_unit', deduped: false });
      const trace = await runJobs.drain();
      expect(trace.executions.map((run) => [run.outcome, run.result])).toEqual([
        ['completed', { eventId: 'evt_unit', type: 'invoice.paid', invoice: 'in_unit' }],
      ]);
    }));

  test('a signed body missing a field is refused by Postly’s code, and nothing is queued', ({
    runJobs,
  }) =>
    withSecrets(SECRET, async () => {
      const body = '{"id":"evt_short","type":"invoice.paid"}';
      const response = await deliver(body, sign(body));
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('X_BILLING_EVENT_UNREADABLE');
      expect(await runJobs.depth(billingEventsReceiver)).toBe(0);
    }));

  test('with no secret set, the delivery is refused before any mac is computed', ({ runJobs }) =>
    withSecrets('', async () => {
      const body = '{"id":"evt_unset","type":"invoice.paid","invoice":"in_unset"}';
      const response = await deliver(body, sign(body, ''));
      expect((await response.json()).code).toBe('X_CONFIG_INVALID');
      expect(await runJobs.depth(billingEventsReceiver)).toBe(0);
    }));
});
