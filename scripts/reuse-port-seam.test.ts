// The enforcement half of `scripts/reuse-port-seam.ts`, run by the gate's `unit` step like every
// `scripts/**/*.test.ts`: a `reusePort` set outside core's seam fails `bun run verify`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  readReusePortSources,
  reusePortResult,
  reusePortSites,
  SHARED_PORT_SEAM,
} from './reuse-port-seam';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'packages/http/src/server.ts';
const seam = { path: SHARED_PORT_SEAM, source: 'export const reusePort = true;' };

describe('reusePort outside the seam', () => {
  test('an options key is reported, with its line', () => {
    expect(reusePortSites(AT, 'Bun.serve({\n  port,\n  reusePort: true,\n});')).toEqual([3]);
  });

  test('a computed key, a string and a scaffold template are reported too', () => {
    expect(reusePortSites(AT, "opts['reusePort'] = true;")).toEqual([1]);
    expect(reusePortSites(AT, 'const reusePort = true;\nBun.serve({ port, reusePort });')).toEqual([
      1, 2,
    ]);
    expect(reusePortSites(AT, 'const src = `Bun.serve({ reusePort: true })`;')).toEqual([1]);
  });

  test('a comment, a longer identifier and the seam itself are not', () => {
    expect(reusePortSites(AT, '// reusePort comes from sharedPortOption\nconst x = 1;')).toEqual(
      [],
    );
    expect(reusePortSites(AT, '/* reusePort */ const reusePorts = 1;')).toEqual([]);
    expect(reusePortSites(SHARED_PORT_SEAM, 'return { reusePort: true };')).toEqual([]);
  });

  test('a message naming the option is prose, not a setting', () => {
    const source = 'cause: `on darwin, where Bun ignores reusePort (SO_REUSEPORT is Linux only)`,';
    expect(reusePortSites(AT, source)).toEqual([]);
    expect(reusePortSites(AT, "const why = 'reusePort is Linux only';")).toEqual([]);
  });

  test('a test file is a fixture, never reported', () => {
    expect(reusePortSites('packages/http/src/server.test.ts', '{ reusePort: true }')).toEqual([]);
  });

  test('a finding names the code, the file and line, and the seam call that replaces it', () => {
    const result = reusePortResult([seam, { path: AT, source: 'x({ reusePort: true });' }]);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'X_REUSEPORT_OUTSIDE_SEAM', at: `${AT}:1` }),
    ]);
    expect(result.findings?.[0]?.fix).toContain('...sharedPortOption(env)');
  });

  test('a scan that never saw the seam proves nothing and says so', () => {
    const result = reusePortResult([{ path: AT, source: 'const x = 1;' }]);
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain('was not among the files scanned');
  });
});

describe('the tree', () => {
  test('spells reusePort only in the seam', async () => {
    const files = await readReusePortSources(repoRoot());
    const result = reusePortResult(files);
    expect(result.findings ?? []).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('the command its fix names is a script this repo declares', async () => {
    const raw: unknown = await Bun.file(`${repoRoot()}/package.json`).json();
    const scripts = typeof raw === 'object' && raw !== null && 'scripts' in raw ? raw.scripts : {};
    expect(Object.keys(scripts ?? {})).toContain('reuse-port-seam');
  });

  test('the seam really spells it, so the exemption is not vacuous', async () => {
    const source = await Bun.file(`${repoRoot()}/${SHARED_PORT_SEAM}`).text();
    expect(source).toContain('reusePort: true');
  });
});
