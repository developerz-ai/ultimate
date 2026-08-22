// The rule against a config key that is declared, defaulted, merged and read by nothing. Asserted
// against `repoRoot()` — the pattern `changelog-check.test.ts` uses — because the finding that
// matters is a fact about THIS tree, not about a fixture.

import { describe, expect, test } from 'bun:test';
// `node:fs/promises`'s `mkdtemp` + `node:os`'s `tmpdir` — Bun ships no temp-directory API;
// `node:path`'s `join` — no Bun path joiner. No `mkdir`: `Bun.write()` creates the parents.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConfigReaders,
  configLeaves,
  configReaderFindingFor,
  configReaderGaps,
  configReaderInput,
  readPattern,
} from './config-readers';
import {
  applyConfigReaderUnpin,
  CONFIG_PINS_FILE,
  CONFIG_READER_PINS,
} from './lib/config-reader-pins';
import { repoRoot } from './lib/run';

const input = await configReaderInput(repoRoot());

describe('unit · every AppConfig leaf key is derived, never listed', () => {
  test('the walk descends a nested section and stops at a scalar', () => {
    const declaration = [
      'export interface McpConfig {',
      '  readonly expose: boolean;',
      '}',
      '',
      'export interface AiConfig {',
      '  readonly mcp: McpConfig;',
      '}',
      '',
      'export interface AppConfig {',
      '  readonly name: string;',
      '  readonly roles: readonly Role[];',
      '  readonly ai: AiConfig;',
      '}',
      '',
    ].join('\n');
    expect(configLeaves(declaration)).toEqual(['name', 'roles', 'ai.mcp.expose']);
  });

  test('and the real declaration yields thirty, ai.mcp.path among them', () => {
    expect(input.leaves).toContain('ai.mcp.path');
    expect(input.leaves).toContain('jobs.visibilityTimeoutMs');
    expect(input.leaves.length).toBeGreaterThanOrEqual(30);
  });

  test('a declaration this cannot parse is UNSCANNED, never a wired config', () => {
    const gaps = checkConfigReaders({ leaves: [], files: input.files, pins: {} });
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(configReaderFindingFor(gaps[0] as never).code).toBe('X_CONFIG_READERS_UNSCANNED');
    // The other half of vacuity: leaves but no files reads exactly the same way.
    expect(
      checkConfigReaders({ leaves: input.leaves, files: [], pins: {} }).map((gap) => gap.kind),
    ).toEqual(['unscanned']);
  });
});

describe('unit · what counts as a read', () => {
  test('a property access and a destructured binding do; a declaration and a literal do not', () => {
    const pattern = readPattern('cache.urlEnv');
    expect(pattern.test('const url = config.cache.urlEnv;')).toBe(true);
    expect(pattern.test('const { urlEnv } = cache;')).toBe(true);
    expect(pattern.test('const { driver, urlEnv, tiers } = cache;')).toBe(true);
    // The declaration itself, and a scaffold template that WRITES the key into a generated file.
    expect(pattern.test('  readonly urlEnv: string | undefined;')).toBe(false);
    expect(pattern.test("cache: { driver: 'redis', urlEnv: 'REDIS_URL' },")).toBe(false);
  });
});

describe('unit · the ratchet', () => {
  /**
   * The five this tree reds on with the pins removed, spelled out. Two of them —
   * `cache.urlEnv` and `realtime.urlEnv` — are `database.urlEnv`'s defect verbatim: `config.ts`
   * validates that the key is PRESENT and nothing reads its VALUE, while the URL is taken from a
   * hardcoded `env['REDIS_URL']` / `env['NATS_URL']` in `@ultimat3/cli`.
   */
  test('unpinned, this tree reports exactly the five keys nothing in packages/*/src reads', () => {
    const gaps = checkConfigReaders({ ...input, pins: {} });
    expect(gaps.map((gap) => gap.leaf).sort()).toEqual([
      'cache.urlEnv',
      'defaultCurrency',
      'defaultTimeZone',
      'realtime.urlEnv',
      'theme.defaultMode',
    ]);
    expect(gaps.every((gap) => gap.kind === 'unread')).toBe(true);
  });

  test('and pinned, the tree is green — so the pins are exactly the reds, with nothing spare', async () => {
    expect(await configReaderGaps(repoRoot())).toEqual([]);
    expect(Object.keys(CONFIG_READER_PINS).sort()).toEqual([
      'cache.urlEnv',
      'defaultCurrency',
      'defaultTimeZone',
      'realtime.urlEnv',
      'theme.defaultMode',
    ]);
  });

  test('every pin carries a sentence naming a reader — a blank one is a waiver', () => {
    for (const [leaf, reason] of Object.entries(CONFIG_READER_PINS)) {
      expect(`${leaf}: ${reason}`.length).toBeGreaterThan(leaf.length + 40);
    }
  });

  test('a pin whose key gained a reader is stale, and the fix is the command that drops it', () => {
    const gaps = checkConfigReaders({
      leaves: ['jobs.concurrency'],
      files: [{ path: 'packages/jobs/src/worker.ts', text: 'const n = options.concurrency;' }],
      pins: { 'jobs.concurrency': 'nobody reads it' },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    expect(configReaderFindingFor(gaps[0] as never).fix).toBe(
      'bun run scripts/config-readers.ts --unpin jobs.concurrency',
    );
    expect(configReaderFindingFor(gaps[0] as never).cause).toContain('now has a reader');
  });

  /**
   * The second way a pin stops holding, and the one that used to be invisible: `read` is built from
   * the CURRENT leaves, so a pin whose `AppConfig` member was deleted matched neither loop and
   * stayed green forever — the orphan waiver this ratchet exists to refuse.
   */
  test('a pin for a key AppConfig no longer declares is stale too, with its own cause', () => {
    const gaps = checkConfigReaders({
      leaves: ['jobs.concurrency'],
      files: [{ path: 'packages/jobs/src/worker.ts', text: 'const n = options.concurrency;' }],
      pins: { 'jobs.driver': 'deleted in 5.0.0, and the pin outlived it' },
    });
    expect(gaps.map((gap) => [gap.kind, gap.leaf, gap.stale])).toEqual([
      ['stale', 'jobs.driver', 'key-deleted'],
    ]);
    const finding = configReaderFindingFor(gaps[0] as never);
    expect(finding.cause).toContain('no longer declares it');
    expect(finding.fix).toBe('bun run scripts/config-readers.ts --unpin jobs.driver');
  });

  /**
   * The `fix:` line, RUN — against a copy of the real pins file, because a multi-line reason is
   * what the entry-delete regex has to survive and a two-line fixture would not have proved it.
   */
  test('--unpin performs the edit the stale finding names, and refuses one that is not stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-config-pins-'));
    const path = join(dir, CONFIG_PINS_FILE);
    await Bun.write(path, await Bun.file(join(repoRoot(), CONFIG_PINS_FILE)).text());

    expect(
      await applyConfigReaderUnpin(
        dir,
        ['cache.urlEnv'],
        [{ kind: 'unread', leaf: 'cache.urlEnv' }],
      ),
    ).toEqual([]);
    expect(await Bun.file(path).text()).toContain("'cache.urlEnv'");

    expect(
      await applyConfigReaderUnpin(
        dir,
        ['cache.urlEnv'],
        [{ kind: 'stale', leaf: 'cache.urlEnv' }],
      ),
    ).toEqual(['cache.urlEnv']);
    const after = await Bun.file(path).text();
    expect(after).not.toContain("'cache.urlEnv'");
    // The neighbours are untouched: a wrapped reason must not take the next entry with it.
    expect(after).toContain("'realtime.urlEnv'");
    expect(after).toContain('defaultTimeZone');
  });

  test('a new dead key is a finding whose fix names the file and the two ways out', () => {
    const gaps = checkConfigReaders({
      leaves: ['jobs.driver'],
      files: [{ path: 'packages/jobs/src/worker.ts', text: 'const n = 1;' }],
      pins: {},
    });
    const finding = configReaderFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_CONFIG_KEY_UNREAD');
    expect(finding.cause).toContain('jobs.driver');
    expect(finding.fix).toContain('packages/core/src/config.ts');
  });
});
