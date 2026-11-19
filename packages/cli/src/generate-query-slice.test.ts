// `x g query` (and `--live`) into a slice an author WROTE. Reproduced on the reference app's
// `posts/`: the read was written importing `canPostsRead`, `postsTag` and `type Posts`, none of
// which the slice exports, and every later command failed to load the app. Refused like
// `x g action` is — while the files are planned, so nothing is on disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive delete and no directory listing.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { entityFiles } from './templates/entity';
import { queryFiles } from './templates/query';

let root = '';
const SLICE = 'apps/web/app/posts';
const slice = { surfaceDir: 'apps/web/app', feature: 'posts' } as const;

const HANDWRITTEN_POLICY = `import { can } from '@ultimat3/policy';
export const postRead = can('post:read');
`;
const SCAFFOLD_ENTITY = String(
  entityFiles('posts', slice).find((file) => file.path.endsWith('/entity.ts'))?.contents,
);

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-query-slice-'));
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unit · x g query into a hand-written slice refuses what would not load', () => {
  for (const live of [false, true]) {
    test(`a policy.ts with no can<Feature>Read is X_SLICE_POLICY_INCOMPLETE and writes nothing (${live ? '--live' : 'cached'})`, async () => {
      await Bun.write(join(root, SLICE, 'entity.ts'), SCAFFOLD_ENTITY);
      await Bun.write(join(root, SLICE, 'policy.ts'), HANDWRITTEN_POLICY);
      const argv = [
        'g',
        'query',
        'recent-posts',
        '--feature',
        'posts',
        ...(live ? ['--live'] : []),
      ];
      const refused = await generateCommand.run(contextFor(argv)).then(
        () => expect.unreachable('it wrote files'),
        (error: { code?: string; cause?: string; fix?: string }) => error,
      );
      expect(refused.code).toBe('X_SLICE_POLICY_INCOMPLETE');
      expect(refused.cause).toContain('canPostsRead');
      expect(refused.cause?.includes('postsTag')).toBe(!live);
      expect(refused.fix).toContain("export const canPostsRead = can('posts:read');");
      // The entity test included: it asserts the scaffold's shape beside a module it did not write.
      expect((await readdir(join(root, SLICE))).sort()).toEqual(['entity.ts', 'policy.ts']);
    });
  }

  // A missing `type` is erased at load and is the typecheck's to name; refusing it would refuse
  // `X_BOUNDARY_ROUTE_TO_DB`'s own printed fix in a slice whose entity.ts an author shaped.
  test('an entity.ts exporting no row type of the slice is still written', () => {
    const typeless = "export const PostView = { id: 'uuid' };\nexport type PostView = string;\n";
    expect(() => queryFiles('recent-posts', { ...slice, sliceEntity: typeless })).not.toThrow();
  });

  test('a scaffolded slice is read as it stands, and gets no second copy of its tests', () => {
    const policy = String(
      queryFiles('first', slice).find((file) => file.path.endsWith('/policy.ts'))?.contents,
    );
    const paths = queryFiles('recent-posts', {
      ...slice,
      sliceEntity: SCAFFOLD_ENTITY,
      slicePolicy: policy,
    }).map((file) => file.path);
    expect(paths).toContain(`${SLICE}/queries/recent-posts.ts`);
    expect(paths).not.toContain(`${SLICE}/entity.test.ts`);
    expect(paths).not.toContain(`${SLICE}/policy.test.ts`);
  });

  test('a barrel policy this cannot follow is "cannot tell": written, never refused on a guess', () => {
    const opaque = "export * from '@acme/policies';\n";
    expect(() => queryFiles('recent-posts', { ...slice, slicePolicy: opaque })).not.toThrow();
  });
});
