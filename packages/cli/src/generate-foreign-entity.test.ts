// A slice whose `entity.ts` an author wrote under another name: `apps/web/app/shortlink/entity.ts`
// declaring `shortLink = entity('short_links', …)`. `x g action ship --feature shortlink` wrote 10
// files, a `repo.ts` reading `db.shortlinks` and a `Shortlink` type nothing declares among them, and
// `x g query` a fifth: 13 type errors. A generator never writes a foundation around another entity.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
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
import { HANDWRITTEN_ENTITY_NO_TENANT } from './scaffold-fixture';

let root = '';
const SLICE = 'apps/web/app/shortlink';

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-foreign-entity-'));
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
  await Bun.write(join(root, SLICE, 'entity.ts'), HANDWRITTEN_ENTITY_NO_TENANT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sourceAt = (path: string): Promise<string> => Bun.file(join(root, path)).text();

describe('unit · a slice holding another entity gets no foundation around it', () => {
  for (const kind of ['action', 'mutator']) {
    test(`x g ${kind} writes its own three files and a policy, never a repo or an entity test`, async () => {
      const result = await generateCommand.run(
        contextFor(['g', kind, 'ship', '--feature', 'shortlink']),
      );
      const files = (result.data as { files: readonly string[] }).files.filter((path) =>
        path.startsWith(`${SLICE}/`),
      );
      expect([...files].sort()).toEqual([
        `${SLICE}/actions/ship.contract.test.ts`,
        `${SLICE}/actions/ship.test.ts`,
        `${SLICE}/actions/ship.ts`,
        `${SLICE}/policy.test.ts`,
        `${SLICE}/policy.ts`,
      ]);
      const action = await sourceAt(`${SLICE}/actions/ship.ts`);
      expect(action).not.toContain("from '../repo'");
      expect(action).not.toContain("from '../errors'");
      expect(action).toContain('shortLink');
      expect(await sourceAt(`${SLICE}/entity.ts`)).toBe(HANDWRITTEN_ENTITY_NO_TENANT);
    });
  }

  test('the mutator twin keys the client store by the declared table', async () => {
    await generateCommand.run(contextFor(['g', 'mutator', 'ship', '--feature', 'shortlink']));
    expect(await sourceAt(`${SLICE}/actions/ship.ts`)).toContain(
      "tx.table<LocalShortlink>('short_links')",
    );
  });

  for (const kind of ['query', 'backfill']) {
    test(`x g ${kind} is refused, and writes nothing`, async () => {
      const refused = await generateCommand
        .run(contextFor(['g', kind, 'list-links', '--feature', 'shortlink']))
        .then(
          () => expect.unreachable('it wrote files'),
          (error: { code?: string; cause?: string; fix?: string }) => error,
        );
      expect(refused.code).toBe(
        kind === 'query' ? 'X_QUERY_SLICE_ENTITY' : 'X_BACKFILL_SLICE_ENTITY',
      );
      expect(refused.cause).toContain('short_links');
      expect(refused.fix?.split('#')[0]).not.toMatch(/<[a-z]/i);
      expect(await Bun.file(join(root, SLICE, 'repo.ts')).exists()).toBe(false);
    });
  }
});
