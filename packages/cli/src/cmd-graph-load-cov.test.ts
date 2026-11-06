// `.x/exercise.json` read as the graph's `observed` edges: a row read is `reads`, any other row
// effect `writes`, an enqueue `enqueues`, a table named by the entity that owns it — and a report
// older than `x.manifest.json`, torn, or of the wrong shape contributes nothing rather than failing.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp or utimes; a fresh directory per case, and an mtime set rather than waited for.
import { mkdtemp, rm, utimes } from 'node:fs/promises';
// why: the scratch roots live under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { EXERCISE_REPORT, observedEdges } from './cmd-graph-load';

const base = await mkdtemp(join(tmpdir(), 'x-graph-observed-'));
afterAll(() => rm(base, { recursive: true, force: true }));

const TABLES = new Map([['x_posts', 'posts']]);

const rootWith = async (report: string): Promise<string> => {
  const root = await mkdtemp(join(base, 'app-'));
  await Bun.write(join(root, EXERCISE_REPORT), report);
  return root;
};

const RECORDS = {
  records: [
    {
      kind: 'action',
      name: 'createPost',
      effects: [
        { kind: 'row', entity: 'x_posts', op: 'insert' },
        { kind: 'enqueue', job: 'notify' },
      ],
    },
    { kind: 'query', name: 'postById', effects: [{ kind: 'row', entity: 'x_tags', op: 'select' }] },
    { kind: 'query', effects: [{ kind: 'row', entity: 'x_posts', op: 'select' }] },
    { kind: 'action', name: 'noop', effects: 'none' },
  ],
};

describe('observedEdges', () => {
  test('row effects are reads or writes on the owning entity, enqueues name the job', async () => {
    const root = await rootWith(JSON.stringify(RECORDS));
    expect(await observedEdges(root, TABLES)).toEqual([
      { from: 'action:createPost', to: 'entity:posts', rel: 'writes' },
      { from: 'action:createPost', to: 'job:notify', rel: 'enqueues' },
      // A table no declared entity owns keeps its own name.
      { from: 'query:postById', to: 'entity:x_tags', rel: 'reads' },
    ]);
  });

  test('a report older than x.manifest.json described an earlier app and adds nothing', async () => {
    const root = await rootWith(JSON.stringify(RECORDS));
    await Bun.write(join(root, 'x.manifest.json'), '{}');
    await utimes(join(root, EXERCISE_REPORT), 1_000, 1_000);
    await utimes(join(root, 'x.manifest.json'), 2_000, 2_000);
    expect(await observedEdges(root, TABLES)).toEqual([]);
  });

  test('a report newer than the manifest is read', async () => {
    const root = await rootWith(JSON.stringify(RECORDS));
    await Bun.write(join(root, 'x.manifest.json'), '{}');
    await utimes(join(root, 'x.manifest.json'), 1_000, 1_000);
    await utimes(join(root, EXERCISE_REPORT), 2_000, 2_000);
    expect(await observedEdges(root, TABLES)).toHaveLength(3);
  });

  test('a torn write, or a report with no records array, adds nothing', async () => {
    expect(await observedEdges(await rootWith('{"records": ['), TABLES)).toEqual([]);
    expect(await observedEdges(await rootWith('{"records": {}}'), TABLES)).toEqual([]);
  });

  test('no report at all adds nothing', async () => {
    expect(await observedEdges(await mkdtemp(join(base, 'empty-')), TABLES)).toEqual([]);
  });
});
