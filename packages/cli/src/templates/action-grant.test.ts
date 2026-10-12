// The unit test `x g action` writes into a slice whose `policy.ts` an author wrote. The failure
// first: the generated test granted `<feature>:write` and expected the handler to answer — but a
// handwritten `canBlogWrite = can('blog:publish')` needs another permission, so the test a
// generator promised to ship passing failed on the first run. The grant is read off the policy
// when it is one literal `can('<perm>')`; when it cannot be read, no assertion depends on it.

import { describe, expect, test } from 'bun:test';
import { INVOICE_ENTITY } from '../scaffold-fixture';
import { actionFiles } from './action';

const slice = { surfaceDir: 'apps/web/app', feature: 'blog' } as const;
const BOTH = "import { tag } from '@ultimat3/cache';\nexport const blogTag = tag('blog');\n";
const PUBLISH = `${BOTH}import { can } from '@ultimat3/policy';\nexport const canBlogWrite = can('blog:publish');\n`;
const COMPOSITE = `${BOTH}import { can, or } from '@ultimat3/policy';\nexport const canBlogWrite = or(can('blog:publish'), can('blog:admin'));\n`;

const sourceOf = (files: ReturnType<typeof actionFiles>, suffix: string): string => {
  const file = files.find((each) => each.path.endsWith(suffix));
  if (file === undefined || typeof file.contents !== 'string')
    return expect.unreachable(`no ${suffix} was emitted`);
  return file.contents;
};

describe('unit · a handwritten single-permission policy: the test grants exactly that permission', () => {
  for (const mutator of [false, true]) {
    test(mutator ? 'mutator' : 'action', () => {
      const files = actionFiles('write-article', { ...slice, mutator, slicePolicy: PUBLISH });
      const unit = sourceOf(files, 'write-article.test.ts');
      expect(unit).toContain("const grant = ['blog:publish'];");
      expect(unit).not.toContain('blog:write');
      expect(unit).toContain('the handler answers a writer in the org');
      const contract = sourceOf(files, 'write-article.contract.test.ts');
      expect(contract).not.toContain('blog:write');
    });
  }
});

describe('unit · a policy whose grant cannot be read: no assertion depends on it', () => {
  for (const policy of [COMPOSITE, `${BOTH}export const canBlogWrite = makeRule();\n`]) {
    test(policy.includes('or(') ? 'or(can, can)' : 'a function call', () => {
      const files = actionFiles('write-article', { ...slice, slicePolicy: policy });
      const unit = sourceOf(files, 'write-article.test.ts');
      expect(unit).not.toContain('const grant');
      expect(unit).not.toContain('the handler answers');
      expect(unit).toContain('is a declared action');
      expect(unit).toContain('rejects input that is not a uuid');
      expect(unit).toMatch(/\/\/ No handler assertion: .*policy\.ts/);
    });
  }

  test('a slice with an entity drops its lookup tests too: they run as a writer', () => {
    const files = actionFiles('send-invoice', {
      surfaceDir: 'apps/web/app',
      feature: 'invoice',
      sliceEntity: INVOICE_ENTITY,
      slicePolicy:
        "import { tag } from '@ultimat3/cache';\nexport const invoiceTag = tag('invoice');\nexport const canInvoiceWrite = rule;\n",
    });
    const unit = sourceOf(files, 'send-invoice.test.ts');
    expect(unit).not.toContain('writer');
    expect(unit).not.toContain('repo.insert');
  });
});

describe('unit · a fresh slice is generated exactly as before', () => {
  test('byte for byte', () => {
    const now = {
      freshNoEntity: actionFiles('write-article', slice),
      freshMutator: actionFiles('write-article', { ...slice, mutator: true }),
      freshEntity: actionFiles('send-invoice', {
        surfaceDir: 'apps/web/app',
        feature: 'invoice',
        sliceEntity: INVOICE_ENTITY,
      }),
    };
    for (const [key, files] of Object.entries(now)) {
      const actions = files
        .filter((file) => file.path.includes('/actions/'))
        .map((file) => ({ path: file.path, contents: file.contents }));
      expect(actions, key).toEqual(FRESH_ACTION_OUTPUT[key] as typeof actions);
    }
  });
});

/**
 * The action generator's output for a FRESH slice (no policy.ts on disk), captured before the
 * handwritten-policy grant work, so that work is held to changing nothing here. In this file, not
 * a fixture module: the source it pins carries an X_* literal the code registry would read as
 * shipped. Regenerate only on purpose.
 */
const FRESH_ACTION_OUTPUT: Readonly<
  Record<string, readonly { readonly path: string; readonly contents: unknown }[]>
> = {
  freshNoEntity: [
    {
      path: 'apps/web/app/blog/actions/write-article.ts',
      contents:
        "// writeArticle: one mutation, server-authoritative. Input is validated before the handler runs\n// and the policy is the same object the MCP tool and the HTTP route evaluate.\n// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.\n\nimport { action, t } from '@ultimat3/action';\n// One directory up: actions live in `actions/`, the feature's errors, policy and repo are the\n// slice's own files and are shared by every action in it.\nimport { blogTag, canBlogWrite } from '../policy';\n\nexport const writeArticle = action({\n  // orgId is part of the input because the policy decides on it — authz reads the declaration,\n  // never the database.\n  input: t.object({ id: t.uuid, orgId: t.uuid }),\n  output: t.object({ id: t.uuid }),\n  policy: canBlogWrite,\n  cache: { invalidates: [blogTag] },\n  // No `mcp`: a tool's description is what an agent reads to decide to call it, and a placeholder\n  // there is worse than no tool. Write one, then `mcp: { expose: true, description: '…' }`.\n  async handle({ input }) {\n    // No lookup by id: this feature has no entity, and a generator writing into a slice never\n    // invents one. `x g entity blog` declares the table; this body is yours until then.\n    return { id: input.id };\n  },\n});\n",
    },
    {
      path: 'apps/web/app/blog/actions/write-article.test.ts',
      contents:
        "// writeArticle: its declared shape, the input it refuses, and what its handler answers — in\n// process, so all three belong to the `unit` step. The contract projections are next door.\nimport { testActor } from '@ultimat3/policy';\nimport { expect, unitTest } from '@ultimat3/testing';\nimport { writeArticle } from './write-article';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId };\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = writeArticle.named('writeArticle');\n\n// Holds the grant in the org the input names: past the policy, so what answers is the handler.\nconst grant = ['blog:write'];\nconst writer = testActor('writer', { orgId, permissions: grant }).actor;\n\nunitTest('writeArticle is a declared action', () => {\n  expect(target.kind).toBe('action');\n  expect(target.describe().name).toBe('writeArticle');\n});\n\nunitTest('writeArticle rejects input that is not a uuid', async () => {\n  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });\n  await expect(target.input).toAcceptInput(input);\n});\n\nunitTest('an actor without the grant is refused before the handler runs', async () => {\n  const stranger = testActor('stranger', { orgId }).actor;\n  const refused = await target.as(stranger, input).catch((error: unknown) => error);\n  expect(refused).toBeUltimateError('X_FORBIDDEN');\n});\n\nunitTest('the handler answers a writer in the org', async () => {\n  expect(await target.as(writer, input)).toEqual({ id });\n});\n",
    },
    {
      path: 'apps/web/app/blog/actions/write-article.contract.test.ts',
      contents:
        "// writeArticle: the contract every action owes, and the foreign-org actor it denies before the\n// handler runs. One declaration, every surface.\nimport { testActor } from '@ultimat3/policy';\nimport { contractTest, expect } from '@ultimat3/testing';\nimport { writeArticle } from './write-article';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId };\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = writeArticle.named('writeArticle');\n\n// Holds the grant, wrong org. That is the interesting actor: a denial here is the predicate\n// deciding, not the permission check, so this test fails if the tenancy rule is ever dropped.\nconst outsider = testActor('outsider', {\n  orgId: '00000000-0000-4000-8000-000000000009',\n  permissions: ['blog:write'],\n}).actor;\n\ncontractTest('writeArticle passes the action contract', async () => {\n  // Three assertions the framework makes for any action, without knowing what this one does:\n  // garbage input is rejected, an anonymous actor is denied, and the operation reaches the\n  // OpenAPI document. `.contract()` is the projection; this loop just runs it.\n  for (const contract of target.contract()) await contract.run();\n});\n\ncontractTest('writeArticle denies a foreign org', async () => {\n  // `.as()` is the one execution path with the actor swapped, so this denial is the same one\n  // HTTP, MCP and the job surface would produce — and no repo call happened to produce it.\n  const denied = await target.as(outsider, input).catch((error: unknown) => error);\n  expect(denied).toBeUltimateError('X_FORBIDDEN');\n});\n\n// No MCP tool until it is described: a placeholder description misleads the agent reading it.\ncontractTest('writeArticle projects one operation and no tool', () => {\n  expect(target.openapi().operationId).toBe('writeArticle');\n  expect(target.mcp?.expose ?? false).toBe(false);\n});\n",
    },
  ],
  freshMutator: [
    {
      path: 'apps/web/app/blog/actions/write-article.ts',
      contents:
        "// writeArticle: an action with an optimistic local twin. The local half runs against the client\n// store immediately; the server half is authoritative and reconciles on conflict.\n\nimport { mutator, t } from '@ultimat3/action';\nimport { canBlogWrite } from '../policy';\n\ninterface LocalBlog {\n  readonly id: string;\n  readonly title: string;\n  readonly pending: boolean;\n}\n\nexport const writeArticle = mutator({\n  input: t.object({ id: t.uuid, orgId: t.uuid, title: t.string }),\n  output: t.object({ id: t.uuid, title: t.string }),\n  policy: canBlogWrite,\n  // Required on a mutator (X_MUTATOR_NOT_IDEMPOTENT): the client replays this write under one\n  // Idempotency-Key after a dropped response, and the replay answers the first result.\n  idempotent: true,\n  // No `mcp` until a real description is written: see `x g action`.\n  // tx.table(name) rather than tx.blogs: the typed accessor exists only once the app\n  // augments LocalTables, and generated code cannot assume that has happened yet. The name is the\n  // entity's snake_case table, so the local twin and the server row live under one key.\n  local(tx, input) {\n    tx.table<LocalBlog>('blogs').update(input.id, {\n      title: input.title,\n      pending: true,\n    });\n  },\n  async server(_ctx, input) {\n    // No lookup by id: this feature has no entity, and a generator writing into a slice never\n    // invents one. `x g entity blog` declares the table; this body is yours until then.\n    return { id: input.id, title: input.title };\n  },\n  conflict: 'server-wins',\n});\n",
    },
    {
      path: 'apps/web/app/blog/actions/write-article.test.ts',
      contents:
        "// writeArticle: its declared shape, the input it refuses, and what its handler answers — in\n// process, so all three belong to the `unit` step. The contract projections are next door.\nimport { testActor } from '@ultimat3/policy';\nimport { expect, memoryLocalTx, unitTest } from '@ultimat3/testing';\nimport { writeArticle } from './write-article';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId, title: 'a title' };\n\n// The client store's table: the entity's own, so the twin and the server row share one key.\nconst TABLE = 'blogs';\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = writeArticle.named('writeArticle');\n\n// Holds the grant in the org the input names: past the policy, so what answers is the handler.\nconst grant = ['blog:write'];\nconst writer = testActor('writer', { orgId, permissions: grant }).actor;\n\nunitTest('writeArticle projects both halves and a conflict strategy', () => {\n  // The projected names mirror the declaration: local() optimistic, server() authoritative.\n  // server() routes through the same invoke() core as every other surface, so it cannot skip\n  // the input parse, the policy or the output parse.\n  expect(target.describeMutator().kind).toBe('mutator');\n  expect(target.conflict).toBe('server-wins');\n  expect(typeof target.local).toBe('function');\n  expect(typeof target.server).toBe('function');\n});\n\nunitTest('writeArticle rejects input that is not a uuid', async () => {\n  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });\n  await expect(target.input).toAcceptInput(input);\n});\n\nunitTest('the local twin marks the row pending, and a replay lands in the same place', () => {\n  const store = memoryLocalTx({ [TABLE]: { [id]: { id, title: 'before', pending: false } } });\n  target.local(store.tx, input);\n  const once = store.rows(TABLE);\n  expect(once).toEqual({ [id]: { id, title: 'a title', pending: true } });\n  // A rebase replays the queued write: twice through must equal once through.\n  target.local(store.tx, input);\n  expect(store.rows(TABLE)).toEqual(once);\n});\n\nunitTest('the local twin invents no row the store never held', () => {\n  const store = memoryLocalTx();\n  target.local(store.tx, input);\n  expect(store.rows(TABLE)).toEqual({});\n});\n\nunitTest('an actor without the grant is refused before the handler runs', async () => {\n  const stranger = testActor('stranger', { orgId }).actor;\n  const refused = await target.as(stranger, input).catch((error: unknown) => error);\n  expect(refused).toBeUltimateError('X_FORBIDDEN');\n});\n\nunitTest('the handler answers a writer in the org', async () => {\n  expect(await target.as(writer, input)).toEqual({ id, title: 'a title' });\n});\n",
    },
    {
      path: 'apps/web/app/blog/actions/write-article.contract.test.ts',
      contents:
        "// writeArticle: the contract every action owes, and the foreign-org actor it denies before the\n// handler runs. One declaration, every surface.\nimport { testActor } from '@ultimat3/policy';\nimport { contractTest, expect } from '@ultimat3/testing';\nimport { writeArticle } from './write-article';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId, title: 'a title' };\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = writeArticle.named('writeArticle');\n\n// Holds the grant, wrong org. That is the interesting actor: a denial here is the predicate\n// deciding, not the permission check, so this test fails if the tenancy rule is ever dropped.\nconst outsider = testActor('outsider', {\n  orgId: '00000000-0000-4000-8000-000000000009',\n  permissions: ['blog:write'],\n}).actor;\n\ncontractTest('writeArticle passes the action contract', async () => {\n  // Three assertions the framework makes for any action, without knowing what this one does:\n  // garbage input is rejected, an anonymous actor is denied, and the operation reaches the\n  // OpenAPI document. `.contract()` is the projection; this loop just runs it.\n  for (const contract of target.contract()) await contract.run();\n});\n\ncontractTest('writeArticle denies a foreign org', async () => {\n  // `.as()` is the one execution path with the actor swapped, so this denial is the same one\n  // HTTP, MCP and the job surface would produce — and no repo call happened to produce it.\n  const denied = await target.as(outsider, input).catch((error: unknown) => error);\n  expect(denied).toBeUltimateError('X_FORBIDDEN');\n});\n\n// No MCP tool until it is described: a placeholder description misleads the agent reading it.\ncontractTest('writeArticle projects one operation and no tool', () => {\n  expect(target.openapi().operationId).toBe('writeArticle');\n  expect(target.mcp?.expose ?? false).toBe(false);\n});\n",
    },
  ],
  freshEntity: [
    {
      path: 'apps/web/app/invoice/actions/send-invoice.ts',
      contents:
        "// sendInvoice: one mutation, server-authoritative. Input is validated before the handler runs\n// and the policy is the same object the MCP tool and the HTTP route evaluate.\n// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.\n\nimport { action, t } from '@ultimat3/action';\n// One directory up: actions live in `actions/`, the feature's errors, policy and repo are the\n// slice's own files and are shared by every action in it.\n\nimport { InvoiceNotFoundError } from '../errors';\nimport { canInvoiceWrite, invoiceTag } from '../policy';\nimport * as repo from '../repo';\n\nexport const sendInvoice = action({\n  // orgId is part of the input because the policy decides on it — authz reads the declaration,\n  // never the database.\n  input: t.object({ id: t.uuid, orgId: t.uuid }),\n  output: t.object({ id: t.uuid, title: t.string }),\n  policy: canInvoiceWrite,\n  cache: { invalidates: [invoiceTag] },\n  // No `mcp`: a tool's description is what an agent reads to decide to call it, and a placeholder\n  // there is worse than no tool. Write one, then `mcp: { expose: true, description: '…' }`.\n  async handle({ input }) {\n    const row = await repo.byId(input.id);\n    if (row === undefined) throw new InvoiceNotFoundError({ id: input.id });\n    return { id: row.id, title: row.title };\n  },\n});\n",
    },
    {
      path: 'apps/web/app/invoice/actions/send-invoice.test.ts',
      contents:
        "// sendInvoice: its declared shape, the input it refuses, and what its handler answers — in\n// process, so all three belong to the `unit` step. The contract projections are next door.\nimport { driver } from '@app/db';\nimport { ctxOf, runWithContext } from '@ultimat3/core';\nimport { testActor } from '@ultimat3/policy';\nimport { afterEach, expect, unitTest } from '@ultimat3/testing';\nimport * as repo from '../repo';\nimport { sendInvoice } from './send-invoice';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId };\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = sendInvoice.named('sendInvoice');\n\n// Holds the grant in the org the input names: past the policy, so what answers is the handler.\nconst grant = ['invoice:write'];\nconst writer = testActor('writer', { orgId, permissions: grant }).actor;\n\n// One store per process: without this, one test's rows are the next test's fixtures.\nafterEach(() => {\n  driver.reset?.();\n});\n\nunitTest('sendInvoice is a declared action', () => {\n  expect(target.kind).toBe('action');\n  expect(target.describe().name).toBe('sendInvoice');\n});\n\nunitTest('sendInvoice rejects input that is not a uuid', async () => {\n  await expect(target.input).toRejectInput({ ...input, id: 'not-a-uuid' });\n  await expect(target.input).toAcceptInput(input);\n});\n\nunitTest('the handler refuses an id nothing holds', async () => {\n  const refused = await target.as(writer, input).catch((error: unknown) => error);\n  expect(refused).toBeUltimateError('X_INVOICE_NOT_FOUND');\n});\n\nunitTest('the handler answers the row it found', async () => {\n  const draft = { orgId, title: 'kept', price: { minor: 0, currency: 'USD' } };\n  const row = await runWithContext(ctxOf({ actor: writer }), () => repo.insert(draft));\n  const answer = await target.as(writer, { id: row.id, orgId });\n  expect(answer).toEqual({ id: row.id, title: 'kept' });\n});\n",
    },
    {
      path: 'apps/web/app/invoice/actions/send-invoice.contract.test.ts',
      contents:
        "// sendInvoice: the contract every action owes, and the foreign-org actor it denies before the\n// handler runs. One declaration, every surface.\nimport { testActor } from '@ultimat3/policy';\nimport { contractTest, expect } from '@ultimat3/testing';\nimport { sendInvoice } from './send-invoice';\n\nconst id = '00000000-0000-4000-8000-000000000001';\nconst orgId = '00000000-0000-4000-8000-000000000002';\nconst input = { id, orgId };\n\n// Named here because every projection needs a stable name and this file does not boot the app.\n// At boot `registerActions(await import('./actions'))` stamps the same name onto the same\n// object, so each projection of it works there with nothing to remember.\nconst target = sendInvoice.named('sendInvoice');\n\n// Holds the grant, wrong org. That is the interesting actor: a denial here is the predicate\n// deciding, not the permission check, so this test fails if the tenancy rule is ever dropped.\nconst outsider = testActor('outsider', {\n  orgId: '00000000-0000-4000-8000-000000000009',\n  permissions: ['invoice:write'],\n}).actor;\n\ncontractTest('sendInvoice passes the action contract', async () => {\n  // Three assertions the framework makes for any action, without knowing what this one does:\n  // garbage input is rejected, an anonymous actor is denied, and the operation reaches the\n  // OpenAPI document. `.contract()` is the projection; this loop just runs it.\n  for (const contract of target.contract()) await contract.run();\n});\n\ncontractTest('sendInvoice denies a foreign org', async () => {\n  // `.as()` is the one execution path with the actor swapped, so this denial is the same one\n  // HTTP, MCP and the job surface would produce — and no repo call happened to produce it.\n  const denied = await target.as(outsider, input).catch((error: unknown) => error);\n  expect(denied).toBeUltimateError('X_FORBIDDEN');\n});\n\n// No MCP tool until it is described: a placeholder description misleads the agent reading it.\ncontractTest('sendInvoice projects one operation and no tool', () => {\n  expect(target.openapi().operationId).toBe('sendInvoice');\n  expect(target.mcp?.expose ?? false).toBe(false);\n});\n",
    },
  ],
};
