// `--unpin <app>:<step>` — the edit `X_REFERENCE_APP_PIN_STALE` names, performed. It fails closed
// at every disagreement, because a pins file this cannot read is a hand edit and deleting the wrong
// line widens the ratchet silently. Every case here runs against a COPY of the real pins file.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `mkdtemp`/`rm`/`join`: the copy needs a real throwaway directory, and Bun ships no
// equivalent — `Bun.write` creates files but never the scratch root, and `Bun.file().unlink()`
// cannot remove a directory tree.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { GatedApp } from './lib/gated-apps';
import { PINS_FILE } from './lib/gated-apps';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { pinnedSteps } from './lib/unpin';
import { unpin } from './reference-app-gate';
import { appWith } from './reference-app-gate.fixtures';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unpin', () => {
  /**
   * A pinned world of its own: a pins file in the shape Biome writes and the table it declares.
   * These cases ran against the real file until 2026-09-23, when both tracked apps' last pins came
   * off — a table with nothing pinned has nothing to unpin, and every case read `undefined`.
   * `lib/unpin.test.ts` still reads the REAL file's shape.
   */
  const WORLD: readonly GatedApp[] = [
    appWith({ typecheck: 'owned elsewhere', drift: 'owned elsewhere' }, 'examples/dummy'),
    appWith({}, 'dummy/social-media-clone'),
  ];
  const SOURCE = [
    'export const GATED_APPS: readonly GatedApp[] = [',
    '  {',
    "    dir: 'examples/dummy',",
    "    reference: './examples/dummy',",
    '    expectedRed: {',
    "      typecheck: 'owned elsewhere',",
    "      drift: 'owned elsewhere',",
    '    } satisfies Partial<Record<VerifyStepName, string>>,',
    '  },',
    '  {',
    "    dir: 'dummy/social-media-clone',",
    "    reference: './dummy/social-media-clone',",
    '    expectedRed: {} satisfies Partial<Record<VerifyStepName, string>>,',
    '  },',
    '];',
    '',
  ].join('\n');

  /** A throwaway repo root holding the pins file, so no test edits the real one. */
  const withPinsCopy = async (
    body: (root: string, path: string) => Promise<void>,
    source: string = SOURCE,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'reference-app-unpin-'));
    const path = join(root, PINS_FILE);
    try {
      await Bun.write(path, source);
      await body(root, path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const target = WORLD[0];
  const unpinIn = (root: string, token: string) => unpin(root, token, WORLD);

  test('removes the named pin and leaves the app’s other pins alone', async () => {
    await withPinsCopy(async (root, path) => {
      const [first, ...rest] = Object.keys(target?.expectedRed ?? {});
      const result = await unpinIn(root, `${target?.dir}:${first}`);
      expect(result.ok).toBe(true);
      expect(result.summary).toContain(`${target?.dir}: unpinned ${first}`);
      expect(pinnedSteps(await Bun.file(path).text(), target?.dir ?? '')).toEqual(rest);
    });
  });

  test('a step that is not pinned changes nothing, and says what is', async () => {
    await withPinsCopy(async (root, path) => {
      const before = await Bun.file(path).text();
      const result = await unpinIn(root, `${target?.dir}:lint`);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.cause).toContain('lint is not pinned');
      expect(await Bun.file(path).text()).toBe(before);
    });
  });

  test('an unknown app names the apps that do exist', async () => {
    await withPinsCopy(async (root) => {
      const result = await unpinIn(root, 'examples/nope:drift');
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.fix).toContain(WORLD[0]?.dir ?? '');
    });
  });

  test('a malformed --unpin is a bad flag, not a guess', async () => {
    await withPinsCopy(async (root) => {
      expect((await unpinIn(root, 'examples/dummy')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect((await unpinIn(root, '')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    });
  });

  test('a file that disagrees with the imported table is refused, entry present or not', async () => {
    // The dangerous near-miss: the entry IS there, so the transform would happily delete it —
    // but the file holds a pin the gate's own import does not, so this process is editing a table
    // it has already misread. Whatever else is wrong, guessing which line to delete is worse.
    const keys = Object.keys(target?.expectedRed ?? {});
    const drifted = [
      '  {',
      `    dir: '${target?.dir}',`,
      '    expectedRed: {',
      ...keys.map((key) => `      ${key}: 'owned elsewhere',`),
      "      lint: 'added on disk after this process imported the table',",
      '    } satisfies Partial<Record<VerifyStepName, string>>,',
      '  },',
    ].join('\n');
    await withPinsCopy(async (root, path) => {
      const result = await unpinIn(root, `${target?.dir}:${keys[0]}`);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
      expect(await Bun.file(path).text()).toBe(drifted);
    }, drifted);
  });

  test('a pins file this cannot read is a hand edit, and the file is left untouched', async () => {
    // The keys are real; the shape is not one the text parser recognises, so the edit must not
    // run — deleting the wrong line here would widen the ratchet silently.
    const mangled = `export const GATED_APPS = [{ dir: '${target?.dir}', expectedRed: {} }];\n`;
    await withPinsCopy(async (root, path) => {
      const result = await unpinIn(
        root,
        `${target?.dir}:${Object.keys(target?.expectedRed ?? {})[0]}`,
      );
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_REFERENCE_APP_PIN_STALE');
      expect(result.findings?.[0]?.fix).toContain(PINS_FILE);
      expect(await Bun.file(path).text()).toBe(mangled);
    }, mangled);
  });
});
