// `--unpin <app>:<step>` — the edit `X_REFERENCE_APP_PIN_STALE` names, performed. It fails closed
// at every disagreement, because a pins file this cannot read is a hand edit and deleting the wrong
// line widens the ratchet silently. Every case here runs against a COPY of the real pins file.

import { describe, expect, test } from 'bun:test';
// why: `mkdtemp`/`rm`/`join`: the copy needs a real throwaway directory, and Bun ships no
// equivalent — `Bun.write` creates files but never the scratch root, and `Bun.file().unlink()`
// cannot remove a directory tree.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { GATED_APPS, PINS_FILE } from './lib/gated-apps';
import { repoRoot } from './lib/run';
import { pinnedSteps } from './lib/unpin';
import { unpin } from './reference-app-gate';

describe('unpin', () => {
  /** A throwaway repo root holding a copy of the real pins file, so no test edits the real one. */
  const withPinsCopy = async (
    body: (root: string, path: string) => Promise<void>,
    source?: string,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'reference-app-unpin-'));
    const path = join(root, PINS_FILE);
    try {
      await Bun.write(path, source ?? (await Bun.file(join(repoRoot(), PINS_FILE)).text()));
      await body(root, path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const target = GATED_APPS.find((candidate) => Object.keys(candidate.expectedRed).length > 1);

  test('removes the named pin and leaves the app’s other pins alone', async () => {
    await withPinsCopy(async (root, path) => {
      const [first, ...rest] = Object.keys(target?.expectedRed ?? {});
      const result = await unpin(root, `${target?.dir}:${first}`);
      expect(result.ok).toBe(true);
      expect(result.summary).toContain(`${target?.dir}: unpinned ${first}`);
      expect(pinnedSteps(await Bun.file(path).text(), target?.dir ?? '')).toEqual(rest);
    });
  });

  test('a step that is not pinned changes nothing, and says what is', async () => {
    await withPinsCopy(async (root, path) => {
      const before = await Bun.file(path).text();
      const result = await unpin(root, `${target?.dir}:lint`);
      expect(result.ok).toBe(false);
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.cause).toContain('lint is not pinned');
      expect(await Bun.file(path).text()).toBe(before);
    });
  });

  test('an unknown app names the apps that do exist', async () => {
    await withPinsCopy(async (root) => {
      const result = await unpin(root, 'examples/nope:drift');
      expect(result.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect(result.findings?.[0]?.fix).toContain(GATED_APPS[0]?.dir ?? '');
    });
  });

  test('a malformed --unpin is a bad flag, not a guess', async () => {
    await withPinsCopy(async (root) => {
      expect((await unpin(root, 'examples/dummy')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
      expect((await unpin(root, '')).findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
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
      const result = await unpin(root, `${target?.dir}:${keys[0]}`);
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
      const result = await unpin(
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
