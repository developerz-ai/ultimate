// A taken port by who has it: this checkout's own problem is a finding; another checkout's server
// is a warning, because nothing is wrong with this environment.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp or mkdir.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { PortOwner } from './dev-lock-holder-dir';
import { portFindings, portWarnings } from './doctor-port';

const taken =
  (...ports: readonly number[]) =>
  async (port: number): Promise<boolean> =>
    !ports.includes(port);

function withApp(run: (app: string, other: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'doctor-port-'));
  const app = join(base, 'app');
  const other = join(base, 'other');
  mkdirSync(join(app, 'apps'), { recursive: true });
  mkdirSync(other);
  return run(app, other).finally(() => rmSync(base, { recursive: true, force: true }));
}

const owned = (owner: PortOwner) => async (): Promise<PortOwner> => owner;

describe('a taken port', () => {
  test("another checkout's server is a warning naming its directory, never a finding", () =>
    withApp(async (root, other) => {
      const probe = {
        root,
        port: 3000,
        portFree: taken(3000, 3001, 3002, 3003),
        portOwner: owned({ pid: 41, command: 'bun', cwd: other }),
      };
      expect(await portFindings(probe)).toEqual([]);
      const warnings = await portWarnings(probe);
      expect(warnings.map((one) => one.code)).toEqual(['X_PORT_IN_USE', 'X_PORT_IN_USE']);
      expect(warnings[0]?.cause).toContain(other);
      expect(warnings[0]?.cause).toContain('pid 41');
      // 3002 and 3003 are taken too: the fix names a pair that is really free.
      expect(warnings[0]?.fix).toBe('x dev --port 3004');
    }));

  test('a server running in this checkout, or below it, stays a finding', () =>
    withApp(async (root) => {
      for (const cwd of [root, join(root, 'apps')]) {
        const probe = {
          root,
          port: 3000,
          portFree: taken(3000),
          portOwner: owned({ pid: 41, cwd }),
        };
        expect((await portFindings(probe)).map((one) => one.code)).toEqual(['X_PORT_IN_USE']);
        expect(await portWarnings(probe)).toEqual([]);
      }
    }));

  test('an owner the OS will not name stays a finding: unknown is never "not yours"', () =>
    withApp(async (root) => {
      const probe = { root, port: 3000, portFree: taken(3000), portOwner: owned({}) };
      expect(await portFindings(probe)).toHaveLength(1);
      expect(await portWarnings(probe)).toEqual([]);
    }));

  test('a sibling sharing the path prefix is another checkout', () =>
    withApp(async (root) => {
      const sibling = `${root}-2`;
      mkdirSync(sibling);
      const probe = { root, port: 3000, portFree: taken(3000), portOwner: owned({ cwd: sibling }) };
      expect(await portFindings(probe)).toEqual([]);
      expect(await portWarnings(probe)).toHaveLength(1);
    }));

  test('an injected portFree never asks the real machine who owns the port', async () => {
    const findings = await portFindings({ root: '/app', port: 3000, portFree: taken(3000) });
    expect(findings.map((one) => one.code)).toEqual(['X_PORT_IN_USE']);
  });
});
