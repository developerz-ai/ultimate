// The enforcement half of `scripts/spawn-timeout.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so an untimed child process above its package pin fails `bun run verify`
// here. Fixtures prove each shape; the last block holds the real tree, non-vacuously.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { SPAWN_TIMEOUT_PINS, SPAWN_TIMEOUT_PINS_FILE } from './lib/spawn-timeout-pins';
import { checkSpawns, scanSpawns, spawnFindingFor, spawnGaps, spawnSites } from './spawn-timeout';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const SHIPPED = 'packages/x/src/run.ts';
const TEST = 'packages/x/src/run.test.ts';

const calls = (path: string, source: string): readonly string[] =>
  scanSpawns(path, source).map((site) => `${String(site.line)}:${site.call}`);

describe('a synchronous spawn', () => {
  test('with no timeout is a site, in shipped source AND in a test', () => {
    const source = "const r = Bun.spawnSync(['git', 'log'], { cwd });\n";
    expect(calls(SHIPPED, source)).toEqual(['1:Bun.spawnSync']);
    expect(calls(TEST, source)).toEqual(['1:Bun.spawnSync']);
  });

  test('every blocking name counts — a node:child_process import included', () => {
    const source = ['spawnSync("a");', 'execSync("b");', 'execFileSync("c", []);'].join('\n');
    expect(calls(SHIPPED, source)).toEqual(['1:spawnSync', '2:execSync', '3:execFileSync']);
  });

  test('with a timeout, a signal, or either as shorthand, is not', () => {
    expect(calls(SHIPPED, 'Bun.spawnSync(["a"], { timeout: 5_000 });')).toEqual([]);
    expect(calls(SHIPPED, 'Bun.spawnSync(["a"], { cwd, timeout });')).toEqual([]);
    expect(
      calls(SHIPPED, 'Bun.spawnSync({ cmd: ["a"], signal: AbortSignal.timeout(5) });'),
    ).toEqual([]);
  });

  test('the word inside a string, a comment or a nested property is not a deadline', () => {
    // `'timeout:'` in the argv is text, `// timeout:` is a comment, `opts.timeout` is a read.
    expect(calls(SHIPPED, 'Bun.spawnSync(["echo", "timeout: 5"]);')).toHaveLength(1);
    expect(calls(SHIPPED, 'Bun.spawnSync(["a"], {\n  // timeout: 5\n  cwd,\n});')).toHaveLength(1);
    expect(calls(SHIPPED, 'Bun.spawnSync(["a"], { cwd: opts.timeout });')).toHaveLength(1);
  });

  test('a spawn named in a comment or a string is no call', () => {
    expect(calls(SHIPPED, '// Bun.spawnSync(["a"])\nconst s = "spawnSync(x)";')).toEqual([]);
  });
});

describe('an asynchronous Bun.spawn', () => {
  test('is read in shipped source, and a deadline clears it', () => {
    expect(calls(SHIPPED, 'const p = Bun.spawn(["ps"], { stdout: "pipe" });')).toEqual([
      '1:Bun.spawn',
    ]);
    expect(calls(SHIPPED, 'const p = Bun.spawn(["ps"], { timeout: 10_000 });')).toEqual([]);
  });

  test('is NOT read in a test, where the test timeout bounds an awaited exit', () => {
    expect(calls(TEST, 'const p = Bun.spawn(["bun", "-e", probe]);\nawait p.exited;')).toEqual([]);
  });
});

describe('the ratchet', () => {
  const site = { path: SHIPPED, line: 3, call: 'Bun.spawnSync' };

  test('a package over its pin is X_SPAWN_UNTIMED, naming the site', () => {
    const [gap] = checkSpawns([site], {}, true);
    const finding = spawnFindingFor(gap ?? expect.unreachable());
    expect(finding.code).toBe('X_SPAWN_UNTIMED');
    expect(finding.cause).toContain(`${SHIPPED}:3 (Bun.spawnSync)`);
    expect(finding.fix).toContain(SPAWN_TIMEOUT_PINS_FILE);
  });

  test('a pin holds it; a pin above the tree is stale, with the command that lowers it', () => {
    const pins = { x: { count: 1, reason: 'why: a dev server its caller kills on exit' } };
    expect(checkSpawns([site], pins, true)).toEqual([]);
    const [stale] = checkSpawns([], pins, true);
    const finding = spawnFindingFor(stale ?? expect.unreachable());
    expect(finding.code).toBe('X_SPAWN_TIMEOUT_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/spawn-timeout.ts --unpin x');
  });

  test('a blank reason waives nothing', () => {
    const gaps = checkSpawns([site], { x: { count: 1, reason: ' ' } }, true);
    const codes = gaps.map((gap) => spawnFindingFor(gap).code);
    expect(codes).toContain('X_SPAWN_TIMEOUT_PIN_UNEXPLAINED');
    expect(codes).toContain('X_SPAWN_UNTIMED');
  });

  test('an empty corpus is X_CORPUS_UNSCANNED, never a clean tree', () => {
    const [gap] = checkSpawns([], {}, false);
    expect(spawnFindingFor(gap ?? expect.unreachable()).code).toBe('X_CORPUS_UNSCANNED');
  });
});

describe('the real tree', () => {
  test('every pin carries a why: and a count above zero', () => {
    for (const pin of Object.values(SPAWN_TIMEOUT_PINS)) {
      expect(pin.reason).toContain('why:');
      expect(pin.count).toBeGreaterThan(0);
    }
  });

  test('is on the ratchet, and the scan really read it', async () => {
    // Non-vacuity: the long-lived children the pins name ARE found — a scan that matched nothing
    // would agree with every pin being stale, and say so, but never with this floor.
    expect((await spawnSites(repoRoot())).length).toBeGreaterThanOrEqual(5);
    expect(await spawnGaps(repoRoot())).toEqual([]);
  });
});
