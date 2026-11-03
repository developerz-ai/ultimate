import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API, and a fixture tree must exist before the probe reads it.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { rollingSinceProbe, withRollingReminder } from './doctor-rolling';
import { MIGRATIONS_DIR } from './migrations';
import type { CommandResult } from './output';
import { VERIFY_FLOOR_FILE } from './verify-floor';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const app = async (floor: object | undefined, migrations: readonly string[]): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'x-doctor-rolling-'));
  roots.push(root);
  mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
  for (const id of migrations)
    await Bun.write(join(root, MIGRATIONS_DIR, `${id}.sql`), 'select 1;\n');
  if (floor !== undefined) await Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify(floor));
  return root;
};

const verdict: CommandResult = {
  ok: true,
  command: 'doctor',
  summary: 's',
  findings: [],
  data: {},
};

describe('x doctor · rollingSince', () => {
  test('unset: one line naming the newest migration, and the verdict untouched', async () => {
    const probe = await rollingSinceProbe(await app({ steps: [] }, ['0001_a', '0002_b']));
    expect(probe).toEqual({ newest: '0002_b' });
    const shown = withRollingReminder(verdict, probe);
    expect(shown.ok).toBe(true);
    expect(shown.findings).toEqual([]);
    expect(shown.lines?.length).toBe(1);
    expect(shown.lines?.[0]).toContain('"rollingSince": "0002_b"');
    expect(shown.data).toMatchObject({ rolling: { unset: true, newest: '0002_b' } });
  });

  test('set: silent', async () => {
    const probe = await rollingSinceProbe(await app({ steps: [], rollingSince: '0' }, ['0001_a']));
    expect(probe).toBeUndefined();
    expect(withRollingReminder(verdict, probe).lines).toBeUndefined();
  });

  test('no migration yet: nothing to name, and new migrations are the generators to refuse', async () => {
    expect(await rollingSinceProbe(await app({ steps: [] }, []))).toBeUndefined();
  });

  test('no floor file: the same line, since the key lives in a file it can create', async () => {
    expect(await rollingSinceProbe(await app(undefined, ['0001_a']))).toEqual({ newest: '0001_a' });
  });
});
