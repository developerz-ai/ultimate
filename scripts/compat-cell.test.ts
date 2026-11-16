// `compat-cell.ts`: what each cell changes before the gate's part runs on it — a Postgres cell's
// compose override (all three Postgres services retagged to its major, PGDATA where the tmpfs is),
// a Solid cell's newest 1.x pinned by `overrides` and proved installed — over injected spawns and
// a temp tree, so nothing here pulls an image or installs a package.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; the cell's tree is a temp directory.
import { join } from 'node:path';
import { composeOverride, newestOf, prepareCell, withSolidOverride } from './compat-cell';
import type { CompatCell } from './compat-cells';
import type { RunResult } from './lib/run';
import { repoRoot } from './lib/run';

const BASE = `services:
  postgres:
    image: pgvector/pgvector:pg17@sha256:${'a'.repeat(64)}
  postgres-standby:
    image: pgvector/pgvector:pg17@sha256:${'a'.repeat(64)}
  postgres-tls:
    image: postgres:17-alpine@sha256:${'b'.repeat(64)}
  redis:
    image: redis:8@sha256:${'c'.repeat(64)}
`;

const cell = (axis: CompatCell['axis'], version: string): CompatCell => ({
  id: `${axis}-${version}`,
  axis,
  version,
  support: 'supported',
});

const ok = (output = ''): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});

describe('unit · compat cell · the Postgres override', () => {
  test('the three Postgres services, retagged to the major, digest dropped, PGDATA on the tmpfs', () => {
    expect(composeOverride(BASE, '18')).toEqual({
      services: {
        postgres: {
          image: 'pgvector/pgvector:pg18',
          environment: { PGDATA: '/var/lib/postgresql/data' },
        },
        'postgres-standby': { image: 'pgvector/pgvector:pg18' },
        'postgres-tls': {
          image: 'postgres:18-alpine',
          environment: { PGDATA: '/var/lib/postgresql/data' },
        },
      },
    });
  });

  test('a tag that names no major is refused rather than guessed', () => {
    const odd = BASE.replace('postgres:17-alpine', 'postgres:latest');
    expect(() => composeOverride(odd, '16')).toThrow('postgres-tls');
  });

  test('the real test services retag cleanly to every Postgres cell', async () => {
    const text = await Bun.file(`${repoRoot()}/docker/docker-compose.test.yml`).text();
    for (const major of ['16', '17', '18']) {
      const images = Object.values(composeOverride(text, major).services).map((one) => one.image);
      expect(images.every((image) => image.includes(major) && !image.includes('@'))).toBe(true);
    }
  });
});

describe('unit · compat cell · the Solid pin', () => {
  test('the newest stable 1.x, never a beta or a 2.0 candidate', () => {
    expect(newestOf(['1.9.18', '1.9.19', '1.10.0-beta.0', '2.0.0-rc.22', '1.9.9'], '1')).toBe(
      '1.9.19',
    );
    expect(newestOf(['2.0.0'], '1')).toBeUndefined();
  });

  test('the root manifest gains an override and keeps every other key', () => {
    const before = `${JSON.stringify({ name: 'r', overrides: { x: '1' } }, null, 2)}\n`;
    const after = JSON.parse(withSolidOverride(before, '1.9.19'));
    expect(after).toEqual({ name: 'r', overrides: { x: '1', 'solid-js': '1.9.19' } });
  });
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const tree = async (installed: string): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'compat-cell-'));
  await Bun.write(join(dir, 'package.json'), '{\n  "name": "r"\n}\n');
  await Bun.write(join(dir, 'docker/docker-compose.test.yml'), BASE);
  await Bun.write(
    join(dir, 'node_modules/solid-js/package.json'),
    JSON.stringify({ version: installed }),
  );
  return dir;
};

describe('unit · compat cell · prepare', () => {
  test('a Postgres cell writes its override where it was asked to', async () => {
    const root = await tree('1.9.18');
    const out = join(root, 'override.yml');
    const answer = await prepareCell({ root, cell: cell('postgres', '16'), composeOut: out });
    expect(answer.ok).toBe(true);
    expect(await Bun.file(out).text()).toContain('pgvector/pgvector:pg16');
  });

  test('a Postgres cell with nowhere to write its override is refused, with the flag to add', async () => {
    const root = await tree('1.9.18');
    const answer = await prepareCell({ root, cell: cell('postgres', '16') });
    expect(answer.ok).toBe(false);
    expect(answer.findings[0]?.fix).toContain('--cell postgres-16 --compose-out');
  });

  test('a Solid cell resolves, pins, installs, and proves the install', async () => {
    const root = await tree('1.9.19');
    const asked: string[] = [];
    const runner = async (command: readonly string[]): Promise<RunResult> => {
      asked.push(command.join(' '));
      return command.includes('view') ? ok('["1.9.18","1.9.19","2.0.0-rc.1"]') : ok();
    };
    const answer = await prepareCell({ root, cell: cell('solid', '1'), runner });
    expect(answer.ok).toBe(true);
    expect(asked).toEqual(['bun pm view solid-js versions --json', 'bun install']);
    expect(await Bun.file(join(root, 'package.json')).text()).toContain('"solid-js": "1.9.19"');
  });

  test('an install that left another Solid in place is refused, never run on', async () => {
    const root = await tree('1.9.18');
    const runner = async (command: readonly string[]): Promise<RunResult> =>
      command.includes('view') ? ok('["1.9.19"]') : ok();
    const answer = await prepareCell({ root, cell: cell('solid', '1'), runner });
    expect(answer.ok).toBe(false);
    expect(answer.findings.map((one) => one.code)).toEqual(['X_COMPAT_CELL_UNPREPARED']);
    expect(answer.findings[0]?.cause).toContain('1.9.18');
  });

  test('a registry that answers no version list is refused before anything is written', async () => {
    const root = await tree('1.9.18');
    const runner = async (): Promise<RunResult> => ok('not json');
    const answer = await prepareCell({ root, cell: cell('solid', '1'), runner });
    expect(answer.findings.map((one) => one.code)).toEqual(['X_COMPAT_CELL_UNPREPARED']);
    expect(await Bun.file(join(root, 'package.json')).text()).not.toContain('solid-js');
  });

  test('a Bun cell prepares nothing and says which Bun it runs', async () => {
    const root = await tree('1.9.18');
    const answer = await prepareCell({ root, cell: cell('bun', 'canary') });
    expect(answer.ok).toBe(true);
    expect(answer.summary).toContain(Bun.version);
  });
});
