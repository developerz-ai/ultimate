// The guard that holds the root README's code sample equal to the real file it quotes. Every
// negative case is a fixture over fake markdown and a fake file — never an edit to `README.md` or to
// `examples/dummy`, both of which other suites read while this one runs.

import { describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory or recursive-delete primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkSamples,
  README_FILE,
  readmeSampleFindings,
  readSamples,
  SAMPLE_MARKER,
  sampleBody,
  sampleFindingFor,
  WRITE_COMMAND,
  writeSamples,
} from './readme-sample';

const FILE = 'examples/fixture/app/actions/cancel.ts';
const SOURCE = [
  '// `cancel`, a fixture action — the header a guard must not quote.',
  '//',
  '// A second header line.',
  '',
  "import { action, t } from '@ultimat3/action';",
  '',
  'export const cancel = action({',
  '  input: t.object({ id: t.uuid }),',
  '});',
  '',
].join('\n');
const BODY = [
  "import { action, t } from '@ultimat3/action';",
  '',
  'export const cancel = action({',
  '  input: t.object({ id: t.uuid }),',
  '});',
];

const readme = (code: readonly string[]): string =>
  ['# Title', '', `<!-- ${SAMPLE_MARKER}: ${FILE} -->`, '```ts', ...code, '```', '', 'after'].join(
    '\n',
  );

const files = (path: string): string | undefined => (path === FILE ? SOURCE : undefined);

describe('unit · the body a README quotes', () => {
  test('is the file below its header comment, trailing blank lines dropped', () => {
    expect(sampleBody(SOURCE)).toEqual(BODY);
  });

  test('a marker binds the fence directly under it', () => {
    const samples = readSamples(readme(BODY));
    expect(samples).toHaveLength(1);
    expect(samples[0]?.file).toBe(FILE);
    expect(samples[0]?.code).toEqual(BODY);
  });
});

describe('unit · a sample that left its file', () => {
  test('agrees when the fence is the file', () => {
    expect(checkSamples(readme(BODY), files)).toEqual([]);
  });

  test('a one-character edit in the example is refused', () => {
    const edited = BODY.map((line) => line.replace('t.uuid', 't.uuie'));
    const gaps = checkSamples(readme(edited), files);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('drift');
    const finding = sampleFindingFor(gaps[0] ?? expect.unreachable('one gap'));
    expect(finding.code).toBe('X_README_SAMPLE_DRIFT');
    expect(finding.fix).toBe('bun run scripts/readme-sample.ts --write');
    expect(finding.cause).toContain(FILE);
  });

  test('a one-character edit in the FILE is refused the same way', () => {
    const moved = (path: string) =>
      path === FILE ? SOURCE.replace('t.uuid', 't.text') : undefined;
    expect(checkSamples(readme(BODY), moved).map((gap) => gap.kind)).toEqual(['drift']);
  });

  test('a quoted file that no longer exists is refused, not skipped', () => {
    const gaps = checkSamples(readme(BODY), () => undefined);
    expect(gaps.map((gap) => gap.kind)).toEqual(['missing']);
    expect(sampleFindingFor(gaps[0] ?? expect.unreachable('one gap')).fix).toContain(README_FILE);
  });

  test('a marker with no fence under it is refused', () => {
    const text = ['<!-- readme-sample: a.ts -->', '', 'prose, then nothing'].join('\n');
    expect(checkSamples(text, files).map((gap) => gap.kind)).toEqual(['unfenced']);
  });

  test('a README with no marker at all is refused — the guard would check nothing', () => {
    const gaps = checkSamples('# no sample\n', files);
    expect(gaps.map((gap) => gap.kind)).toEqual(['unmarked']);
    expect(sampleFindingFor(gaps[0] ?? expect.unreachable('one gap')).fix).toContain(WRITE_COMMAND);
  });

  test('every kind of gap names the README line it is about', () => {
    const unfenced = sampleFindingFor({ kind: 'unfenced', file: FILE, line: 3 });
    expect(unfenced.at).toBe(`${README_FILE}:3`);
    expect(unfenced.fix).toContain(WRITE_COMMAND);
    expect(sampleFindingFor({ kind: 'missing', file: FILE, line: 3 }).cause).toContain(FILE);
  });
});

describe('unit · --write', () => {
  test('rewrites a drifted fence from its file and leaves the rest alone', () => {
    const written = writeSamples(readme(['stale']), files);
    expect(written).toBe(readme(BODY));
    expect(checkSamples(written, files)).toEqual([]);
  });
});

describe('unit · a root with no README', () => {
  // The manifest host check runs over fixture roots too (doc-paths.test.ts), and a tree with no
  // README makes no sample claim: nothing to compare, so no finding, and never a thrown ENOENT.
  test('gives no finding and does not throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'readme-sample-'));
    try {
      expect(await readmeSampleFindings(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('repo · the root README', () => {
  // Reads the real tree: the repo-scan backstop, not Bun's 5000ms default.
  test(
    'quotes its file exactly',
    async () => {
      expect(await readmeSampleFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
