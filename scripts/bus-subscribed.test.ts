// The failure cases first — a publish with nothing before it, and one after a reconnect — then what
// must never be one: a confirmed subscription, a stated reason, a durable event table, a unit test.
// Every input is built by hand: a test that edits a real live test to prove the rule races the gate.

import { describe, expect, test } from 'bun:test';
import {
  type BusPublishGap,
  busPublishFindingFor,
  checkBusPublishes,
  scanBusPublishes,
} from './bus-subscribed';

const PATH = 'packages/realtime/src/a.live.test.ts';
const HEAD = "import { NatsTransport } from './nats-transport';";
const scan = (...lines: string[]) => scanBusPublishes(PATH, [HEAD, ...lines].join('\n'));

describe('scanBusPublishes', () => {
  test('a publish with no confirmation before it in its test is reported, by its line', () => {
    const found = scan(
      "test('x', async () => {",
      "  await subscriber.subscribe('x.a', handler);",
      '});',
      "test('y', async () => {",
      "  await publisher.publish('x.a', 'lost');",
      "  await a.hub.publishEvent(room, { orgId: 'o1' }, { n: 1 });",
      '});',
    );
    expect(found.map((site) => [site.line, site.after])).toEqual([
      [6, 'nothing'],
      [7, 'nothing'],
    ]);
  });

  test('a reconnect between the confirmation and the publish un-confirms it', () => {
    const found = scan(
      "test('x', async () => {",
      '  const held = await subscribed({ subscriber, publisher, subject, handler });',
      '  relay.cut();',
      '  await waitFor(() => bus.connected);',
      "  await publisher.publish(subject, 'after');",
      '});',
    );
    expect(found.map((site) => [site.line, site.after])).toEqual([
      [6, 'the connection step at line 5'],
    ]);
  });

  test('a confirmation, re-confirmed after the reconnect, is enough', () => {
    expect(
      scan(
        "test('x', async () => {",
        '  const held = await subscribed({ subscriber, publisher, subject, handler });',
        "  await publisher.publish(subject, 'before');",
        '  relay.cut();',
        '  await waitFor(() => bus.connected);',
        '  await held.subscribed();',
        "  await publisher.publish(subject, 'after');",
        "  await hub.subscribeChannel(socket, { kind: 'channel', channel, params });",
        '  await hub.publishEvent(room, params, event);',
        '});',
      ),
    ).toEqual([]);
  });

  test('a stated reason on the line or the one above keeps it; a bare marker and prose do not', () => {
    const found = scan(
      "test('x', async () => {",
      '  // bus-order: lost by design, inside the black-hole window',
      "  await publisher.publish(subject, 'void');",
      "  await publisher.publish(subject, 'kept'); // bus-order: a beat round trip ordered it",
      '  // bus-order:',
      "  await publisher.publish(subject, 'bare');",
      "  // await subscriber.subscribe('x', h);",
      "  await publisher.publish(subject, 'prose');",
      '});',
    );
    expect(found.map((site) => site.line)).toEqual([7, 9]);
  });

  test('a durable event table and a unit test are out of scope', () => {
    const events = "test('x', async () => {\n  await bus.publish('otp', { code: 1 });\n});";
    expect(scanBusPublishes('packages/jobs/src/events.live.test.ts', events)).toEqual([]);
    const unit = `${HEAD}\ntest('x', async () => {\n  await bus.publish('x.a', 'p');\n});`;
    expect(scanBusPublishes('packages/realtime/src/a.test.ts', unit)).toEqual([]);
  });
});

describe('checkBusPublishes — the ratchet', () => {
  const file = {
    path: PATH,
    text: `${HEAD}\ntest('x', async () => {\n  await publisher.publish('x.a', 'p');\n});`,
  };

  test('over its pin is an instruction naming the site and the helper', () => {
    const [gap] = checkBusPublishes({ files: [file], pins: {} });
    expect(gap?.kind).toBe('over');
    const finding = busPublishFindingFor(gap as BusPublishGap);
    expect(finding.code).toBe('X_TEST_BUS_UNCONFIRMED');
    expect(finding.cause).toContain(`${PATH}:3`);
    expect(finding.fix.startsWith('const held = await subscribed(')).toBe(true);
  });

  test('a pin above the tree is stale, and the fix lowers it', () => {
    const [gap] = checkBusPublishes({ files: [], pins: {} });
    expect(gap?.kind).toBe('unscanned');
    const [stale] = checkBusPublishes({ files: [file], pins: { realtime: 3 } });
    expect(stale?.kind).toBe('stale');
    expect(busPublishFindingFor(stale as BusPublishGap).fix).toBe(
      'bun run scripts/bus-subscribed.ts --unpin realtime',
    );
  });
});
