// Single responsibility: pins the work a request-scoped logger costs — `ctxOf` calls `child()` per
// request, so a child must not re-validate its level by rendering a refusal it never throws, and a
// bound field is redacted once, when it is bound, not again on every line.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { frozenClock } from './clock';
import * as errorRender from './error-render';
import { REDACTED, redactKeys, structuredLogger } from './logger';

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = structuredLogger({
    level: 'info',
    clock: frozenClock('2026-07-26T10:00:00.000Z'),
    writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

test('child() never renders a refusal message: the level is already valid', () => {
  const { logger } = capture();
  const render = spyOn(errorRender, 'renderCauseValue');
  spies.push(render);
  logger.child({ requestId: 'r1' }).child({ traceId: 't1' });
  expect(render).not.toHaveBeenCalled();
});

test('a valid level renders nothing either; only a refusal builds its message', () => {
  const render = spyOn(errorRender, 'renderCauseValue');
  spies.push(render);
  structuredLogger({ level: 'warn', writer: () => undefined }).withLevel('debug');
  expect(render).not.toHaveBeenCalled();
});

test('a bound field is redacted once, in child, not again on every line', () => {
  const { logger, lines } = capture();
  const at = new Date('2026-07-26T09:00:00.000Z');
  let renders = 0;
  const original = at.toISOString.bind(at);
  at.toISOString = () => {
    renders += 1;
    return original();
  };
  const child = logger.child({ at, password: 'hunter2' });
  child.info('one');
  child.info('two');
  child.child({ step: 3 }).info('three');
  expect(renders).toBe(1);
  expect(lines.map((line) => [line['at'], line['password']])).toEqual([
    ['2026-07-26T09:00:00.000Z', '[redacted]'],
    ['2026-07-26T09:00:00.000Z', '[redacted]'],
    ['2026-07-26T09:00:00.000Z', '[redacted]'],
  ]);
  expect(lines[2]).toMatchObject({ step: 3 });
});

test('a child field still wins over the parent’s, after both were redacted', () => {
  const { logger, lines } = capture();
  logger.child({ queue: 'default', attempt: 1 }).child({ attempt: 2 }).info('picked up');
  expect(lines[0]).toMatchObject({ queue: 'default', attempt: 2 });
});

test('a key declared secret AFTER a child bound it is still redacted on that child', () => {
  // `defineEnv` calls `redactKeys` at boot, and a logger bound before it ran kept the plaintext.
  const { logger, lines } = capture();
  const child = logger.child({ stripeWebhookLateProbe: 'whsec_live_123' });
  redactKeys(['stripeWebhookLateProbe']);
  child.info('a');
  child.child({ step: 2 }).info('b');
  expect(lines.map((line) => line['stripeWebhookLateProbe'])).toEqual([REDACTED, REDACTED]);
});
