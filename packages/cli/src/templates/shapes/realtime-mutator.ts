// `--shape realtime`'s mutator: a rename this tab shows before the server answers, and the write
// every other tab's live list then patches in. Its unit and contract tests beside it.

import type { GeneratedFile, NameSet } from '../naming';

const ACTIONS = 'apps/web/app/post/actions';

const renamePost =
  (): string => `// renamePost: a rename this tab shows before the server answers, and every other tab shows once it
// lands. \`local\` writes the twin into this tab's store at once; \`server\` is the write, and it is
// authoritative: the committed row reaches every \`postList\` subscriber as a patch, on every node.

import { mutator, t } from '@ultimat3/action';
import { PostNotFoundError } from '../errors';
import { canPostWrite, postTag } from '../policy';
import * as repo from '../repo';

/** The client store's row: the entity's own table, so the twin and the server row share a key. */
interface LocalPost {
  readonly id: string;
  readonly title: string;
  readonly pending: boolean;
}

export const renamePost = mutator({
  // \`orgId\` because the policy decides on it; 200 is the entity's own bound on a title.
  input: t.object({ id: t.uuid, orgId: t.uuid, title: t.string.min(1).max(200) }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: canPostWrite,
  cache: { invalidates: [postTag] },
  // Required on a mutator (X_MUTATOR_NOT_IDEMPOTENT): the client replays this write under one
  // Idempotency-Key after a dropped response, and the replay answers the first result.
  idempotent: true,
  // The refusals a caller may branch on: add each code the handler comes to throw.
  errors: [PostNotFoundError.code],
  local(tx, input) {
    tx.table<LocalPost>('posts').update(input.id, { title: input.title, pending: true });
  },
  async server(_ctx, input) {
    // Another org's id reads nothing — the handle scopes the read — so it is "not found" too.
    if ((await repo.byId(input.id)) === undefined) throw new PostNotFoundError({ id: input.id });
    const row = await repo.rename(input.id, input.title);
    return { id: row.id, title: row.title };
  },
  conflict: 'server-wins',
});
`;

const renamePostTest = (
  app: NameSet,
): string => `// renamePost: the twin this tab shows at once, and the write the server makes — in process, so
// both belong to the \`unit\` step. The contract projections are next door.
import { driver } from '@${app.kebab}/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, memoryLocalTx, unitTest } from '@ultimat3/testing';
import * as repo from '../repo';
import { renamePost } from './rename-post';

const id = '00000000-0000-4000-8000-000000000001';
const orgId = '00000000-0000-4000-8000-000000000002';
const otherOrg = '00000000-0000-4000-8000-000000000009';
const target = renamePost.named('renamePost');
const writer = testActor('writer', { orgId, permissions: ['post:write'] }).actor;

const store = (owner: string, title: string) => {
  const draft = { orgId: owner, title, price: { minor: 0, currency: 'USD' } };
  const actor = testActor('author', { orgId: owner }).actor;
  return runWithContext(ctxOf({ actor }), () => repo.insert(draft));
};

afterEach(() => {
  driver.reset?.();
});

unitTest('the twin is marked pending at once, and a replay lands in the same place', () => {
  const local = memoryLocalTx({ posts: { [id]: { id, title: 'before', pending: false } } });
  target.local(local.tx, { id, orgId, title: 'after' });
  const once = local.rows('posts');
  expect(once).toEqual({ [id]: { id, title: 'after', pending: true } });
  target.local(local.tx, { id, orgId, title: 'after' });
  expect(local.rows('posts')).toEqual(once);
});

unitTest('the server writes the new title, and a read sees it', async () => {
  const row = await store(orgId, 'before');
  const answer = await target.as(writer, { id: row.id, orgId, title: 'after' });
  expect(answer).toEqual({ id: row.id, title: 'after' });
  const read = await runWithContext(ctxOf({ actor: writer }), () => repo.byId(row.id));
  expect(read?.title).toBe('after');
});

unitTest('an id nothing holds, or another org’s, is not found and nothing is written', async () => {
  const theirs = await store(otherOrg, 'theirs');
  const refused = await target
    .as(writer, { id: theirs.id, orgId, title: 'mine now' })
    .catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_POST_NOT_FOUND');
  const outsider = testActor('outsider', { orgId: otherOrg }).actor;
  const kept = await runWithContext(ctxOf({ actor: outsider }), () => repo.byId(theirs.id));
  expect(kept?.title).toBe('theirs');
});
`;

const renamePostContract =
  (): string => `// renamePost: the contract every action owes — a mutator's server half is one — and the
// caller in another org it refuses before the handler runs.
import { testActor } from '@ultimat3/policy';
import { contractTest, expect } from '@ultimat3/testing';
import { exercise } from '../../../exercise';
import { renamePost } from './rename-post';

const target = renamePost.named('renamePost');
const orgId = '00000000-0000-4000-8000-000000000002';
const input = { id: '00000000-0000-4000-8000-000000000001', orgId, title: 'renamed' };

contractTest('renamePost passes the action contract', async () => {
  for (const contract of target.contract({ exercise })) await contract.run();
});

contractTest('renamePost is refused to a writer of another org', async () => {
  const outsider = testActor('outsider', {
    orgId: '00000000-0000-4000-8000-000000000009',
    permissions: ['post:write'],
  }).actor;
  const refused = await target.as(outsider, input).catch((error: unknown) => error);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});
`;

/** The mutator and its two suites. */
export const realtimeMutatorFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${ACTIONS}/rename-post.ts`, contents: renamePost() },
  { path: `${ACTIONS}/rename-post.test.ts`, contents: renamePostTest(app) },
  { path: `${ACTIONS}/rename-post.contract.test.ts`, contents: renamePostContract() },
];
