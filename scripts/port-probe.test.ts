// The probe first — bind 0, release, hand the number on — then what must never be one: a listener
// held, a release deferred to a hook, the helper's own file, a shipped module. Then the ratchet's
// answers, and the tree itself: this file is the build error the gate's `unit` step runs.

import { describe, expect, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkPortProbes, portProbeFindingFor, portProbeGaps, scanPortProbes } from './port-probe';

const TEST = 'packages/x/src/a.test.ts';
const scan = (lines: readonly string[], path = TEST) => scanPortProbes(path, lines.join('\n'));

const PROBE = [
  'function freeOne(): number {',
  "  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });",
  '  const port = probe.port ?? 0;',
  '  probe.stop(true);',
  '  return port;',
  '}',
];

describe('scanPortProbes', () => {
  test('a port bound as 0, released, and returned is a probe, by its line', () => {
    expect(scan(PROBE)).toEqual([{ path: TEST, line: 2, form: 'probe' }]);
  });

  test('every spelling of the release and the hand-off', () => {
    const listen = [
      'const closed = () => {',
      '  const listener = Bun.listen({',
      "    hostname: '127.0.0.1',",
      '    port: 0,',
      '    socket: { data() {} },',
      '  });',
      '  const { port } = listener;',
      '  void listener.stop(true);',
      "  if (port === undefined) return expect.unreachable('no port');",
      '  return port;',
      '};',
    ];
    expect(scan(listen).map((site) => site.line)).toEqual([2]);
  });

  test('the helper’s internals named outside its file are a probe by another name', () => {
    const found = scan([
      "import { freePortPair } from '../packages/testing/src/free-port';",
      'const port = freePortPair();',
    ]);
    expect(found.map((site) => [site.line, site.form])).toEqual([
      [1, 'helper'],
      [2, 'helper'],
    ]);
  });

  test('a listener held, or released by a hook after the test, is no probe', () => {
    expect(
      scan([
        'function held(): number {',
        '  const holder = Bun.serve({ port: 0, fetch: () => new Response() });',
        '  stops.push(() => holder.stop(true));',
        '  return holder.port ?? 0;',
        '}',
        'function used(): void {',
        '  const server = Bun.serve({ port: 0, fetch: () => new Response() });',
        '  expect(server.port).toBeGreaterThan(0);',
        '  server.stop(true);',
        '}',
      ]),
    ).toEqual([]);
  });

  test('prose and the helper’s own home are not sites; a shipped module is out of scope', () => {
    expect(scan(['// freePort() was the old way: bind 0, stop, return the number'])).toEqual([]);
    expect(scan(PROBE, 'packages/testing/src/free-port.ts')).toEqual([]);
    expect(scan(PROBE, 'packages/testing/src/free-port-bind.test.ts')).toEqual([]);
    expect(scan(PROBE, 'packages/cli/src/dev-supervisor.ts')).toEqual([]);
    // A fixture, the harness and a script ARE what a test runs.
    expect(scan(PROBE, 'packages/cli/src/cmd-dev-boot-fixture.ts')).toHaveLength(1);
    expect(scan(PROBE, 'packages/testing/src/e2e-spawn.ts')).toHaveLength(1);
    expect(scan(PROBE, 'scripts/scaffold-admin.ts')).toHaveLength(1);
  });
});

describe('the ratchet', () => {
  const files = [{ path: TEST, text: PROBE.join('\n') }];

  test('a site over its package’s pin is X_TEST_PORT_PROBED, naming the site and the helper', () => {
    const [gap, ...rest] = checkPortProbes({ files, pins: {} });
    expect(rest).toEqual([]);
    if (gap === undefined) return expect.unreachable('a probe over a zero pin is a gap');
    const finding = portProbeFindingFor(gap);
    expect(finding.code).toBe('X_TEST_PORT_PROBED');
    expect(finding.cause).toContain(`${TEST}:2 (probe)`);
    expect(finding.fix.startsWith('bindFreePorts(')).toBe(true);
  });

  test('a pin above what the tree holds is stale, and the fix lowers it', () => {
    const [gap] = checkPortProbes({ files, pins: { x: 3 } });
    if (gap === undefined) return expect.unreachable('a pin above the tree is a gap');
    const finding = portProbeFindingFor(gap);
    expect(finding.code).toBe('X_TEST_PORT_PROBE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/port-probe.ts --unpin x');
  });

  test('a pin the tree meets exactly is no gap; nothing read is never a clean tree', () => {
    expect(checkPortProbes({ files, pins: { x: 1 } })).toEqual([]);
    const [gap] = checkPortProbes({ files: [], pins: {} });
    expect(gap?.kind).toBe('unscanned');
  });
});

test(
  'the tree holds no probed port above its pins',
  async () => {
    expect((await portProbeGaps(repoRoot())).map(portProbeFindingFor)).toEqual([]);
  },
  REPO_SCAN_TIMEOUT_MS,
);
