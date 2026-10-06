// The raw-CDP shot driver's fake WIRE, shared by the driver's unit files: every call goes through
// the real `cdpConnectOver` framing, so what a test asserts is the CDP a real browser receives.
import type { CdpTransport } from '@ultimat3/testing';
import { cdpConnectOver } from '@ultimat3/testing';
import type { ShotClock, ShotSessionInit } from './browser-launcher-port';
import { cdpShotDriver } from './cdp-shot-driver';

export interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string | undefined;
}

export type Answer = (call: Call) => Record<string, unknown> | undefined;

/** One browser on the other end of a transport: answers by method, emits events on demand. */
export function fakeWire(answer: Answer = () => undefined) {
  let handlers: Parameters<CdpTransport['listen']>[0] | undefined;
  const calls: Call[] = [];
  const transport: CdpTransport = {
    send(text) {
      const frame = JSON.parse(text) as Call & { id: number };
      calls.push({ method: frame.method, params: frame.params, sessionId: frame.sessionId });
      queueMicrotask(() =>
        handlers?.message(JSON.stringify({ id: frame.id, result: answer(frame) ?? {} })),
      );
    },
    close: () => undefined,
    listen(next) {
      handlers = next;
    },
  };
  const connection = cdpConnectOver(transport, 1_000);
  return {
    connection,
    calls,
    emit(method: string, params: Record<string, unknown>, sessionId = 'S1') {
      handlers?.message(JSON.stringify({ method, params, sessionId }));
    },
    methods: (): string[] => calls.map((call) => call.method),
  };
}

/** Sleeping IS advancing: a 30-second deadline finishes in microseconds. */
export const testClock = (): ShotClock => {
  let mono = 0;
  return {
    now: () => new Date(1_700_000_000_000 + mono),
    monotonic: () => mono,
    sleep: async (ms) => {
      mono += ms;
      await Promise.resolve();
    },
  };
};

export const init = (overrides: Partial<ShotSessionInit> = {}): ShotSessionInit => ({
  name: 'x shot',
  rules: { allowHosts: ['localhost'] },
  clock: testClock(),
  timeoutMs: 1_000,
  ...overrides,
});

export const attach: Answer = (call) => {
  if (call.method === 'Target.createTarget') return { targetId: 'T1' };
  if (call.method === 'Target.attachToTarget') return { sessionId: 'S1' };
  if (call.method === 'Target.attachToBrowserTarget') return { sessionId: 'B1' };
  return undefined;
};

export const evaluating =
  (values: (expression: string) => unknown): Answer =>
  (call) =>
    call.method === 'Runtime.evaluate'
      ? { result: { value: values(String(call.params['expression'])) } }
      : attach(call);

export const opened = async (answer: Answer = attach, overrides: Partial<ShotSessionInit> = {}) => {
  const wire = fakeWire(answer);
  let closed = 0;
  const driver = cdpShotDriver({
    executablePath: '/usr/bin/chrome',
    launch: async () => ({
      connection: wire.connection,
      close: async () => {
        closed += 1;
      },
    }),
  });
  const session = await driver.open(init(overrides));
  return { wire, session, page: session.page, closedCount: () => closed };
};
