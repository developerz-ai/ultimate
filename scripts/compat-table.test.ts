// `compat-table.ts`: the supported-runtime table `wiki/Stability.md` prints, rendered from the
// compat matrix and the three pins the gate runs — and the REAL page held to it, so a cell added
// to `compat.yml`, a moved pin or a hand edit to the table is a red test until `--write` runs.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; a pin fixture is a temp tree.
import { join } from 'node:path';
import type { CompatMatrix } from './compat-cells';
import {
  checkCompatTable,
  compatTableFindings,
  readPins,
  renderCompatTable,
  STABILITY_PAGE,
  writeCompatTable,
} from './compat-table';
import { GENERATED_CLOSE, generatedOpen } from './lib/generated-block';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real workflow, page and pins, so the file runs on the repo-scan budget.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const MATRIX: CompatMatrix = {
  cells: [
    { id: 'bun-canary', axis: 'bun', version: 'canary', support: 'watched' },
    { id: 'postgres-18', axis: 'postgres', version: '18', support: 'supported' },
    { id: 'solid-1', axis: 'solid', version: '1', support: 'supported' },
  ],
  parts: [],
};
const PINS = { bun: '1.4.4', postgres: '17', solid: '1.9.18' };
const OPEN = generatedOpen('compat-table', 'bun run scripts/compat-table.ts --write');

describe('unit · compat table · render', () => {
  test('each axis: its pin first, then each cell, with what runs it and what it promises', () => {
    const table = renderCompatTable(MATRIX, PINS);
    expect(table.slice(0, 2)).toEqual([
      '| Runtime | Version | Run by | Status |',
      '|---|---|---|---|',
    ]);
    expect(table[2]).toBe(
      '| Bun | `1.4.4`, the pin (`.bun-version`) | the gate, every push and pull request (`ci.yml`) | supported |',
    );
    expect(table[3]).toBe(
      '| Bun | canary | `compat.yml` cell `bun-canary`, weekly | watched: tested, never promised |',
    );
    expect(table).toContain(
      '| Postgres | newest `18.x` image | `compat.yml` cell `postgres-18`, weekly | supported |',
    );
    expect(table.at(-1)).toBe(
      '| Solid | newest `1.x` | `compat.yml` cell `solid-1`, weekly | supported |',
    );
  });
});

describe('unit · compat table · drift', () => {
  const page = (body: readonly string[]) =>
    ['# S', '', OPEN, ...body, GENERATED_CLOSE, ''].join('\n');

  test('a page whose block is what renders is clean; `--write` makes one so', () => {
    const fresh = writeCompatTable(page(['stale']), MATRIX, PINS);
    expect(checkCompatTable(fresh, MATRIX, PINS)).toEqual([]);
  });

  test('a hand-edited block and a missing block are X_COMPAT_TABLE_DRIFT', () => {
    expect(checkCompatTable(page(['| hand | made |']), MATRIX, PINS).map((f) => f.code)).toEqual([
      'X_COMPAT_TABLE_DRIFT',
    ]);
    const missing = checkCompatTable('# S\n', MATRIX, PINS);
    expect(missing.map((f) => f.code)).toEqual(['X_COMPAT_TABLE_DRIFT']);
    expect(missing[0]?.fix).toContain(OPEN);
  });
});

describe('unit · compat table · the real page', () => {
  test('the pins are read off the files the gate runs', async () => {
    const pins = await readPins(repoRoot());
    expect(pins.bun).toBe((await Bun.file(`${repoRoot()}/.bun-version`).text()).trim());
    expect(pins.postgres).toMatch(/^\d+$/);
    expect(pins.solid).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('a Postgres image with no major in its tag is refused, never read as no pin', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compat-pins-'));
    await Bun.write(join(dir, '.bun-version'), '1.4.4\n');
    await Bun.write(
      join(dir, 'docker/docker-compose.test.yml'),
      'services:\n  postgres:\n    image: pgvector/pgvector:latest\n',
    );
    await Bun.write(join(dir, 'package.json'), '{"devDependencies":{"solid-js":"1.9.18"}}');
    await expect(readPins(dir)).rejects.toThrow('Postgres');
  });

  test(`${STABILITY_PAGE} prints the table compat.yml and the pins render`, async () => {
    expect(await compatTableFindings(repoRoot())).toEqual([]);
  });
});
