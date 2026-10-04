// `x verify --json` in a real process: one line per finished step on STDERR, the one document on
// stdout. A job cancelled mid-run ends its log on the last step that finished (#589) — which is
// only true if the lines leave the process as the steps finish, so this spawns one.

import { expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from './app-root';

const BIN = join(import.meta.dir, 'bin.ts');

const run = async (root: string, argv: readonly string[]) => {
  const proc = Bun.spawn(['bun', BIN, 'verify', ...argv, '--cwd', root], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr };
};

test('--json streams each finished step to stderr and keeps stdout one document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-verify-stream-'));
  try {
    await Bun.write(join(root, APP_CONFIG_FILE), "export const config = { name: 'fixture' };\n");
    await Bun.write(join(root, 'apps/web/app/a.ts'), 'export const a = 1;\n');
    const json = await run(root, ['--only', 'filesize,package-shape', '--json']);
    const lines = json.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { step: string; ok: boolean; ms: number });
    expect(lines.map((line) => line.step)).toEqual(['filesize', 'package-shape']);
    expect(lines[0]?.ok).toBe(true);
    expect(typeof lines[0]?.ms).toBe('number');
    // stdout is still exactly one JSON document, with the same steps.
    const document = JSON.parse(json.stdout) as { steps: readonly { name: string }[] };
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(document.steps.map((step) => step.name)).toEqual(['filesize', 'package-shape']);

    // The human render already reads as it goes at the end; it gets no JSON on stderr.
    const human = await run(root, ['--only', 'filesize']);
    expect(human.stderr).not.toContain('"step"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
