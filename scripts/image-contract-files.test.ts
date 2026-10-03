// Which files the image contract reads. It read `docker/Dockerfile` alone, so the demo's
// `Dockerfile.monorepo` — the image `deploy-social-demo.yml` actually ships — was never checked,
// and a Dockerfile with no ignore file at all passed the master-key rule by having nothing to read.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:` — Bun has no temporary-directory or recursive-remove primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { SECRETS_KEY_FILE } from '@ultimat3/core';
import {
  dockerfilesOf,
  imageContractFindings,
  SECRET_IGNORE_PATTERN,
  SKIPPED_DIRS,
} from './image-contract';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const roots: string[] = [];

const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-image-files-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const GOOD = [
  'FROM oven/bun:1.3-slim AS build',
  'RUN bun build --compile --outfile /out/app ./x.ts',
  'FROM gcr.io/distroless/cc-debian13 AS runtime',
  'COPY --from=build /out/app /app/x',
  'RUN ["/app/x", "--version"]',
  'ENTRYPOINT ["/app/x"]',
  '',
].join('\n');

const IGNORE = `**/.env\n${SECRET_IGNORE_PATTERN}\n`;

describe('every Dockerfile in the tree is read', () => {
  test('a broken Dockerfile outside docker/ is a finding that names it', async () => {
    const root = await tree({
      'docker/Dockerfile': GOOD,
      'docker/Dockerfile.dockerignore': IGNORE,
      'apps/edge/Dockerfile.worker': GOOD.replace('oven/bun:1.3-slim', 'oven/bun:1.3-alpine'),
      'apps/edge/Dockerfile.worker.dockerignore': IGNORE,
    });
    const found = await imageContractFindings(root);
    expect(found.map((one) => one.code)).toEqual(['X_IMAGE_LIBC_MISMATCH']);
    expect(found[0]?.at).toStartWith('apps/edge/Dockerfile.worker:');
    expect(found[0]?.fix).toContain('-f apps/edge/Dockerfile.worker');
  });

  test(
    'this tree: all four Dockerfiles, the deployed demo image included, and each is clean',
    async () => {
      const files = await dockerfilesOf(repoRoot());
      expect(files).toContain('dummy/social-media-clone/docker/Dockerfile.monorepo');
      expect(files).toContain('docker/Dockerfile');
      expect(files.length).toBeGreaterThanOrEqual(4);
      expect(files.some((file) => file.endsWith('.dockerignore'))).toBe(false);
      expect(await imageContractFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

describe('a Dockerfile with no ignore file', () => {
  test('is a finding: nothing keeps the master key out of its build context', async () => {
    const root = await tree({ 'docker/Dockerfile': GOOD });
    const found = await imageContractFindings(root);
    expect(found.map((one) => one.code)).toEqual(['X_IMAGE_SECRET_UNIGNORED']);
    expect(found[0]?.at).toBe('docker/Dockerfile');
    expect(found[0]?.cause).toContain('no ignore file');
    expect(found[0]?.cause).toContain(SECRETS_KEY_FILE);
    expect(found[0]?.fix).toContain('docker/Dockerfile.dockerignore');
  });

  test('a per-Dockerfile ignore, or a .dockerignore at or above it, is an ignore file', async () => {
    for (const ignore of [
      'docker/Dockerfile.dockerignore',
      'docker/.dockerignore',
      '.dockerignore',
    ]) {
      const root = await tree({ 'docker/Dockerfile': GOOD, [ignore]: IGNORE });
      expect(await imageContractFindings(root)).toEqual([]);
    }
  });

  test('a .dockerignore BELOW the Dockerfile is not one docker would read', async () => {
    const root = await tree({ 'docker/Dockerfile': GOOD, 'docker/sub/.dockerignore': IGNORE });
    const codes = (await imageContractFindings(root)).map((one) => one.code);
    expect(codes).toEqual(['X_IMAGE_SECRET_UNIGNORED']);
  });
});

describe('what discovery never reads', () => {
  // A `dist/` build output or a `.x/` run directory holding a Dockerfile is a generated copy, not
  // a Dockerfile this tree ships — reading one turned the gate red over a file nobody wrote.
  test('a Dockerfile under a generated or installed tree is not one this tree ships', async () => {
    const broken = GOOD.replace('oven/bun:1.3-slim', 'oven/bun:1.3-alpine');
    const root = await tree({
      'docker/Dockerfile': GOOD,
      'docker/Dockerfile.dockerignore': IGNORE,
      ...Object.fromEntries(
        SKIPPED_DIRS.map((dir) => [`packages/x/${dir}/Dockerfile`, broken] as const),
      ),
    });
    expect(await dockerfilesOf(root)).toEqual(['docker/Dockerfile']);
    expect(await imageContractFindings(root)).toEqual([]);
  });

  // A walk that cannot read the tree is not a clean tree, and its refusal is an instruction —
  // the raw ENOENT carried no code, no cause and no fix.
  test('a tree that cannot be walked is a coded refusal, never a bare filesystem error', async () => {
    const thrown = await dockerfilesOf(join(tmpdir(), 'ultimate-image-files-never-made')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ScriptError);
    expect((thrown as ScriptError).code).toBe('X_CORPUS_UNSCANNED');
    expect((thrown as ScriptError).fix).toBe('bun run scripts/image-contract.ts --json');
  });
});
