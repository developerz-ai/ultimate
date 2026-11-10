// `x doctor` over an app a TypeScript major behind: the finding, its runnable fix, where it sits
// in `runDoctor`'s order, and the probe reading a real app's root and workspace manifests.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { runDoctor } from './cmd-doctor';
import { codes, probe } from './cmd-doctor-fixture';
import { typescriptFindings, typescriptProbe } from './doctor-typescript';
import { TYPESCRIPT_VERSION } from './templates/scaffold-repo';

const LAG = {
  file: 'package.json',
  field: 'devDependencies',
  from: '^6.0.3',
  to: TYPESCRIPT_VERSION,
  fix: `bun add -d 'typescript@${TYPESCRIPT_VERSION}'`,
} as const;

describe('x doctor · a TypeScript below the scaffold`s', () => {
  test('is X_TYPESCRIPT_VERSION, at the manifest, its fix the bun add that moves it', () => {
    expect(typescriptFindings([LAG])).toEqual([
      {
        code: 'X_TYPESCRIPT_VERSION',
        at: 'package.json',
        cause: expect.stringContaining(
          `package.json declares devDependencies.typescript "^6.0.3", below the ${TYPESCRIPT_VERSION}`,
        ),
        fix: `bun add -d 'typescript@${TYPESCRIPT_VERSION}'`,
        docs: expect.stringMatching(/^https:\/\//),
      },
    ]);
  });

  test('runDoctor reports it inside an app, right after the runtime checks', async () => {
    expect(await codes(probe({ typescript: async () => [LAG] }))).toEqual(['X_TYPESCRIPT_VERSION']);
    const old = await runDoctor(probe({ bunVersion: '1.0.0', typescript: async () => [LAG] }));
    expect(old.map((finding) => finding.code)).toEqual(['X_BUN_VERSION', 'X_TYPESCRIPT_VERSION']);
    // Outside an app there is no manifest to judge, and the probe is not asked.
    const outside = probe({
      root: undefined,
      typescript: async () => expect.unreachable('asked outside an app'),
    });
    expect(await codes(outside)).toEqual(['X_NOT_IN_APP']);
  });
});

describe('x doctor · typescriptProbe', () => {
  test('reads the root manifest and each workspace`s, and names the lagging one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-ts-'));
    try {
      await Bun.write(
        join(root, 'package.json'),
        JSON.stringify({
          workspaces: ['apps/*'],
          devDependencies: { typescript: TYPESCRIPT_VERSION },
        }),
      );
      await Bun.write(
        join(root, 'apps/web/package.json'),
        JSON.stringify({ name: 'web', devDependencies: { typescript: '~6.0.3' } }),
      );
      const lags = await typescriptProbe(root);
      expect(lags.map((lag) => [lag.file, lag.fix])).toEqual([
        ['apps/web/package.json', `bun add -d 'typescript@${TYPESCRIPT_VERSION}' --cwd apps/web`],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an unreadable root manifest is bun install`s finding, not a second one here', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-doctor-ts-'));
    try {
      await Bun.write(join(root, 'package.json'), '{ not json');
      expect(await typescriptProbe(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
