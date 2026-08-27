// The rule against a config key that is declared, defaulted, merged and read by nothing. Asserted
// against `repoRoot()` — the pattern `changelog-check.test.ts` uses — because the finding that
// matters is a fact about THIS tree, not about a fixture.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `node:fs/promises`'s `mkdtemp` + `node:os`'s `tmpdir` — Bun ships no temp-directory API;
// `node:path`'s `join` — no Bun path joiner. No `mkdir`: `Bun.write()` creates the parents.
import { mkdtemp } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  AMBIGUOUS_LIMIT,
  checkConfigReaders,
  configDeclaration,
  configLeaves,
  configReaderFindingFor,
  configReaderGaps,
  configReaderInput,
  owningPackage,
  readPattern,
} from './config-readers';
import {
  applyConfigReaderUnpin,
  CONFIG_AMBIGUOUS_PINS,
  CONFIG_PINS_FILE,
  CONFIG_READER_PINS,
} from './lib/config-reader-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Every test below scans the whole tree, so the budget is the file's default rather than a third
// argument per test — see `REPO_SCAN_TIMEOUT_MS`. This file ran on Bun's 5000ms default until
// 2026-08-27 and went red on a runtime 1.3x slower, which is less than one noisy CI runner.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

  test('and the real declaration yields twenty-seven, ai.mcp.path among them', () => {
    expect(input.leaves).toContain('ai.mcp.path');
    expect(input.leaves).toContain('jobs.visibilityTimeoutMs');
    // A key of the section declared in the OTHER file of `CONFIG_FILES`, so a walk that reads only
    // the first one is red here rather than five keys shorter in silence.
    expect(input.leaves).toContain('pwa.name');
    // AN OPTIONAL SECTION IS STILL A SECTION, `As of 2026-08-27`. `pwa.colors` was ONE leaf until
    // then because its type is `PwaColors | undefined` and the walk descended only into a BARE
    // named type — so the four values an installable app cannot boot without were never asked for
    // a reader, which is the whole point of this rule. `wiki/Upgrading.md` naming them is what
    // surfaced it: `doc-config-keys` reads the same walk and called two real keys unknown.
    for (const scheme of ['light', 'dark'])
      for (const key of ['themeColor', 'backgroundColor'])
        expect(input.leaves).toContain(`pwa.colors.${scheme}.${key}`);
    expect(input.leaves).not.toContain('pwa.colors');
    // A vacuity FLOOR, not the surface: it says the scan reached the real `config.ts` rather than
    // an empty parse. Thirty until `cache.driver` and `cache.urlEnv` were deleted, twenty-eight
    // until `realtime.tier` went the same way — a key this rule reported as having no reader at
    // all once `ambiguityOf` could see past nineteen bare-name collisions. It moves DOWN with a
    // deleted key and never with an added one.
    expect(input.leaves.length).toBeGreaterThanOrEqual(27);
  });

  // THE FILE SPLIT IS THE HOLE THIS CLOSES. `configLeaves` treats a member whose named type it
  // cannot find as a LEAF — so when `PwaConfig` moved to `config-pwa.ts` and `CONFIG_FILES` was
  // still one path, `pwa` became one leaf where six had been, the five that vanished stopped being
  // asked about, and this rule printed `✓`. A derivation that silently shrinks is the defect the
  // whole check exists to catch, one level up, so the next split has to be red rather than quiet.
  test('every section AppConfig names resolves in the declaration the walk reads', async () => {
    const declaration = await configDeclaration(repoRoot());
    const root = /export interface AppConfig\s*\{([\s\S]*?)\n\}/.exec(declaration);
    expect(root).not.toBeNull();
    const sections = [...(root?.[1] ?? '').matchAll(/readonly\s+(\w+)\s*:\s*(\w*Config)\s*;/g)];
    // The scan is worthless if it found nothing. A FLOOR: it moves down with a deleted section.
    expect(sections.length).toBeGreaterThanOrEqual(9);
    const unresolved = sections
      .filter(([, , type]) => !declaration.includes(`export interface ${String(type)} {`))
      .map(([, key, type]) => `${String(key)}: ${String(type)}`);
    expect(`sections CONFIG_FILES does not declare: ${unresolved.join(', ')}`).toBe(
      'sections CONFIG_FILES does not declare: ',
    );
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

describe('unit · nineteen readers is the alarm, not the all-clear', () => {
  const noisy = (count: number, key: string) =>
    Array.from({ length: count }, (_at, index) => ({
      path: `packages/cache/src/file-${String(index)}.ts`,
      text: `const t = row.${key};`,
    }));

  test('a bare name matching more than the limit, with none in its own package, is reported', () => {
    const gaps = checkConfigReaders({
      leaves: ['realtime.tier'],
      files: noisy(AMBIGUOUS_LIMIT + 1, 'tier'),
      pins: {},
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['ambiguous']);
    const finding = configReaderFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_CONFIG_KEY_READER_AMBIGUOUS');
    expect(finding.cause).toContain('packages/realtime/');
    expect(finding.fix).toContain('CONFIG_AMBIGUOUS_PINS');
  });

  test('one hit inside the section own package settles it, however loud the rest', () => {
    const gaps = checkConfigReaders({
      leaves: ['realtime.tier'],
      files: [
        ...noisy(40, 'tier'),
        { path: 'packages/realtime/src/socket.ts', text: 'const t = cfg.tier;' },
      ],
      pins: {},
    });
    expect(gaps).toEqual([]);
  });

  test('the qualified <section>.<key> spelt anywhere settles it too', () => {
    const gaps = checkConfigReaders({
      leaves: ['realtime.tier'],
      files: [
        ...noisy(40, 'tier'),
        { path: 'packages/cli/src/boot.ts', text: 'const t = config.realtime.tier;' },
      ],
      pins: {},
    });
    expect(gaps).toEqual([]);
  });

  test('at or below the limit the old looseness stands — a narrow name is still evidence', () => {
    expect(
      checkConfigReaders({
        leaves: ['realtime.tier'],
        files: noisy(AMBIGUOUS_LIMIT, 'tier'),
        pins: {},
      }),
    ).toEqual([]);
  });

  test('a top-level leaf has no section to qualify, and is never reported ambiguous', () => {
    expect(checkConfigReaders({ leaves: ['name'], files: noisy(200, 'name'), pins: {} })).toEqual(
      [],
    );
  });

  test('a section whose package is named differently resolves through SECTION_PACKAGE', () => {
    expect(owningPackage('database.driver')).toBe('db');
    expect(owningPackage('theme.tokens')).toBe('ui');
    expect(owningPackage('ai.mcp.path')).toBe('mcp');
    expect(owningPackage('name')).toBeUndefined();
  });

  /**
   * The rule switches itself off for any section whose owner resolves to a directory that is not
   * there — silently, and for every key in it. Asserted against the real tree so a package rename
   * is a failing test rather than a check that quietly stops asking.
   */
  test('every section this tree declares resolves to a real package directory', () => {
    const owners = new Set(
      input.leaves.map((leaf) => owningPackage(leaf)).filter((one) => one !== undefined),
    );
    expect(owners.size).toBeGreaterThan(4);
    for (const owner of owners) {
      expect(input.files.some((file) => file.path.startsWith(`packages/${owner}/`))).toBe(true);
    }
  });

  test('a pin whose doubt is settled is stale, with its own cause and the unpin command', () => {
    const gaps = checkConfigReaders({
      leaves: ['realtime.tier'],
      files: [{ path: 'packages/realtime/src/socket.ts', text: 'const t = cfg.tier;' }],
      pins: {},
      ambiguousPins: { 'realtime.tier': 'the bare name matches 19 files' },
    });
    expect(gaps.map((gap) => [gap.kind, gap.stale])).toEqual([['stale', 'now-qualified']]);
    expect(configReaderFindingFor(gaps[0] as never).fix).toBe(
      'bun run scripts/config-readers.ts --unpin realtime.tier',
    );
  });

  test('an ambiguity pin for a key AppConfig no longer declares is stale too', () => {
    const gaps = checkConfigReaders({
      leaves: ['realtime.transport'],
      files: [{ path: 'packages/realtime/src/socket.ts', text: 'const t = cfg.transport;' }],
      pins: {},
      ambiguousPins: { 'realtime.tier': 'deleted with the key it excused' },
    });
    expect(gaps.map((gap) => [gap.leaf, gap.stale])).toEqual([['realtime.tier', 'key-deleted']]);
  });
});

describe('unit · the ratchet', () => {
  /**
   * The four this tree reds on with the pins removed, spelled out. It was five: `cache.urlEnv` was
   * `database.urlEnv`'s defect verbatim — `config.ts` validated that the key was PRESENT while the
   * URL came from a hardcoded `env['REDIS_URL']` — and it was DELETED with `cache.driver` rather
   * than re-pinned. `realtime.urlEnv` is the same defect against `env['NATS_URL']` and is still
   * pinned, which is what a ratchet that may only shrink looks like from one release to the next.
   */
  test('unpinned, this tree reports exactly the four keys nothing in packages/*/src reads', () => {
    const gaps = checkConfigReaders({ ...input, pins: {}, ambiguousPins: {} }).filter(
      (gap) => gap.kind === 'unread',
    );
    expect(gaps.map((gap) => gap.leaf).sort()).toEqual([
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
      'defaultCurrency',
      'defaultTimeZone',
      'realtime.urlEnv',
      'theme.defaultMode',
    ]);
  });

  test('the ambiguity pins are exactly this tree reds, with nothing spare', () => {
    const gaps = checkConfigReaders({ ...input, pins: {}, ambiguousPins: {} }).filter(
      (gap) => gap.kind === 'ambiguous',
    );
    expect(gaps.map((gap) => gap.leaf).sort()).toEqual(Object.keys(CONFIG_AMBIGUOUS_PINS).sort());
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
        ['realtime.urlEnv'],
        [{ kind: 'unread', leaf: 'realtime.urlEnv' }],
      ),
    ).toEqual([]);
    expect(await Bun.file(path).text()).toContain("'realtime.urlEnv'");

    expect(
      await applyConfigReaderUnpin(
        dir,
        ['realtime.urlEnv'],
        [{ kind: 'stale', leaf: 'realtime.urlEnv' }],
      ),
    ).toEqual(['realtime.urlEnv']);
    const after = await Bun.file(path).text();
    expect(after).not.toContain("'realtime.urlEnv'");
    // The neighbours are untouched: a wrapped reason must not take the next entry with it.
    expect(after).toContain("'theme.defaultMode'");
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
