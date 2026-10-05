// The one delivery harness every `webhook()` test file drives: an injected `fetch` the test
// answers, a memory ledger, a frozen clock, and a resolver that maps every host to a public address
// unless a test says otherwise. Test-only (`-fixture.ts` is outside the published `files`).

import { type Ctx, createContext, frozenClock, isUltimateError } from '@ultimat3/core';
import { createStepRunner } from './steps';
import { createMemoryStepStore } from './steps-memory';
import { type WebhookDefinition, type WebhookEndpoint, webhook } from './webhook';
import { type MemoryWebhookLedger, memoryWebhookLedger } from './webhook-ledger';

export const SECRET = 'whsec_never_leaks';
const NOW_MS = 1_700_000_000_000;

export const ctx: Ctx = createContext();

export const ENDPOINT: WebhookEndpoint = {
  id: 'ep_1',
  url: 'https://hooks.partner.test/inbox?token=leaks-if-rendered',
  secret: SECRET,
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

export interface Harness {
  readonly ledger: MemoryWebhookLedger;
  readonly sent: Sent[];
  answer: () => Promise<Response>;
  run(attempt?: number): Promise<unknown>;
  readonly handle: ReturnType<typeof webhook>;
}

let sequence = 0;

/** Called from each file's `beforeEach`, so job names restart at `partner-hooks-1`. */
export const resetHarness = (): void => {
  sequence = 0;
};

/** A public address the harness resolves every hostname to, unless a test says otherwise. */
export const PUBLIC_IP = '93.184.215.14';

export const harness = (
  over: {
    endpoint?: WebhookEndpoint | null;
    topic?: string;
    disableAfter?: number;
    resolve?: (hostname: string) => Promise<readonly string[]>;
    allowPrivate?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Harness => {
  sequence += 1;
  const ledger = memoryWebhookLedger();
  const sent: Sent[] = [];
  const state = {
    ledger,
    sent,
    answer: (): Promise<Response> => Promise.resolve(new Response('ok', { status: 200 })),
  };

  const definition: WebhookDefinition = {
    name: `partner-hooks-${sequence}`,
    tenant: 'none',
    ledger,
    clock: frozenClock(NOW_MS),
    ...(over.disableAfter === undefined ? {} : { disableAfter: over.disableAfter }),
    resolve: over.resolve ?? (() => Promise.resolve([PUBLIC_IP])),
    ...(over.allowPrivate === undefined ? {} : { allowPrivate: over.allowPrivate }),
    ...(over.env === undefined ? {} : { env: over.env }),
    endpoint: () => (over.endpoint === undefined ? ENDPOINT : over.endpoint),
    event: ({ eventId }) =>
      eventId === 'evt_missing'
        ? null
        : { topic: over.topic ?? 'orders.paid', body: '{"amount":100}' },
    fetch: (url, init) => {
      sent.push({ url, init });
      return state.answer();
    },
  };

  const handle = webhook(definition);
  return {
    ...state,
    handle,
    run: (attempt = 1): Promise<unknown> =>
      handle.run({
        input: { endpointId: 'ep_1', eventId: 'evt_1' },
        step: createStepRunner({
          runId: `run-${sequence}`,
          jobName: definition.name,
          store: createMemoryStepStore(),
        }).step,
        ctx,
        attempt,
        finalAttempt: false,
        progress: () => undefined,
        jobId: `job-${sequence}`,
        runId: `run-${sequence}`,
      }),
    get answer() {
      return state.answer;
    },
    set answer(next: () => Promise<Response>) {
      state.answer = next;
    },
  } as Harness;
};

export const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
  }
  return 'delivered';
};
