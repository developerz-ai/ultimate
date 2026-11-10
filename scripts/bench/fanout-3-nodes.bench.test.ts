// The fan-out bench with no NATS: three nodes in this process over one in-process bus, the real
// probe loop and the real aggregation — what the published run does, minus the processes. Plus the
// child's stdout reader and the flags refused before anything starts.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearChannels } from '../../packages/realtime/src/channel-registry';
import { InProcessTransport } from '../../packages/realtime/src/fanout';
import { ScriptError } from '../lib/script-error';
import {
  benchFanout3,
  type FanoutRig,
  fanoutArgs,
  fanoutReport,
  lineStarting,
} from './fanout-3-nodes.bench';
import { fanoutNode, fanoutNodeArgs } from './fanout-node-child';

afterAll(() => {
  clearChannels();
});

/** Three nodes and the publisher on one in-process bus: the rig `natsRig` is, without processes. */
const inProcessRig = async (org: string, counts: readonly number[], events: number) => {
  const bus = new InProcessTransport();
  const nodes = await Promise.all(
    counts.map((subscribers) => fanoutNode(bus, { org, subscribers, events, windowMs: 5_000 })),
  );
  const rig: FanoutRig = {
    publisher: bus,
    finals: () => Promise.all(nodes.map((node) => node.final)),
    close: async () => {
      for (const node of nodes) await node.close();
    },
  };
  return rig;
};

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof ScriptError ? error.code : 'not a ScriptError';
  }
  return undefined;
};

/** A stream that hands over `chunks`, then ends. */
const streamOf = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }).getReader();

describe('fan-out bench', () => {
  test('every probe reaches every socket on every node, and the figure counts them', async () => {
    const run = await benchFanout3(
      { subscribers: 7, events: 3, intervalMs: 10, settleMs: 0 },
      (org, counts) => inProcessRig(org, counts, 3),
    );
    expect({ nodes: run.nodes, delivered: run.delivered, expected: run.expected }).toEqual({
      nodes: 3,
      delivered: 21,
      expected: 21,
    });
    expect(run.perNode.map((node) => node.deliveries)).toEqual([9, 6, 6]);
    expect(run.overall.maxMs).toBeGreaterThanOrEqual(run.overall.p50Ms);
    expect(fanoutReport(run, 10, false)).toStartWith('7 subscribers on 3 nodes, 3 probes: 21/21');
    expect(JSON.parse(fanoutReport(run, 10, true))).toMatchObject({ intervalMs: 10 });
  });

  test('a node whose window closes first reports what it got, never hangs', async () => {
    const bus = new InProcessTransport();
    const node = await fanoutNode(bus, { org: 'quiet', subscribers: 2, events: 1, windowMs: 20 });
    expect(await node.final).toMatchObject({ received: 0, expected: 2 });
    await node.close();
  });

  test('the stdout reader finds its line across chunks, and refuses a stream that ended first', async () => {
    const carry = { buffer: '' };
    const reader = streamOf(['noise\nRE', 'ADY\nFINAL {"a":1}\n']);
    expect(await lineStarting(reader, carry, 'READY')).toBe('');
    expect(await lineStarting(reader, carry, 'FINAL ')).toBe('{"a":1}');
    const ended = await lineStarting(streamOf(['nothing\n']), { buffer: '' }, 'READY').then(
      () => 'resolved',
      (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
    );
    expect(ended).toBe('X_BENCH_RUN_FAILED');
  });

  test('flags: a NATS url is required, counts are bounded', () => {
    expect(codeOf(() => fanoutArgs([], {}))).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(() => fanoutArgs(['--nats', 'nats://x:4222', '--subscribers', '1'], {}))).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(fanoutArgs([], { TEST_NATS_URL: 'nats://x:4222' })).toMatchObject({
      nats: 'nats://x:4222',
      subscribers: 10_000,
      events: 20,
      intervalMs: 250,
    });
    expect(codeOf(() => fanoutNodeArgs(['--nats', 'n', '--org', 'o']))).toBe('X_CLI_BAD_FLAG');
    expect(
      fanoutNodeArgs(['--nats', 'n', '--org', 'o', '--subscribers', '2', '--events', '3']),
    ).toEqual({ nats: 'n', org: 'o', subscribers: 2, events: 3 });
  });
});
