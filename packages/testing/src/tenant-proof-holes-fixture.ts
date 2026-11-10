// The planted holes, one primitive each, on `tenant-proof-fixture.ts`'s memory app: every one is a
// way past the repository guard an agent writes without noticing, and every one MUST read crossed.
// The scoped, public and throwing primitives beside them must not. Registered at module scope.

import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { serviceActor, UltimateError, withChildContext } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import { blocks, defineMail, send } from '@ultimat3/mail';
import { allow, can, definePermissions } from '@ultimat3/policy';
import { from, query } from '@ultimat3/query';
import { registerQueries } from '@ultimat3/query/loader';
import { tpDriver, tpFiles, tpLabelCache, tpLinks, tpVaults } from './tenant-proof-fixture';

// Declared here, never left to another file: the permission set is one per process, and once
// any file declares one, `can()` refuses a name nobody declared (X_PERMISSION_UNKNOWN) — so in
// one process, which file was imported first decided whether this one loaded.
definePermissions(['tp:read', 'tp:write']);

const files = () => tpDriver.repo(tpFiles);
const vaults = () => tpDriver.repo(tpVaults);

const missing = (what: string): never => {
  throw new UltimateError({
    code: 'X_NOT_FOUND',
    cause: `no such ${what}`,
    fix: 'x exercise <name> --json   # bind a seeded id of the actor tenant',
  });
};

const Ok = t.object({ ok: t.boolean });
const Url = t.object({ url: t.string });
const Label = t.object({ label: t.string });
const byFile = t.object({ tpFileId: t.uuid });
const byVault = t.object({ tpVaultId: t.uuid });

registerCatalog('en', loadCatalog({ tp: { notice: { heading: 'A file changed' } } }));
// A subject is a carried key, so it is one the framework ships (`scripts/catalog-keys.ts`).
const tpNotice = defineMail<{ ok: boolean }>({
  id: 'tp-notice',
  subject: 'mail.footer.legal',
  input: t.object({ ok: t.boolean }),
  template: () => [blocks.heading('tp.notice.heading')],
});

/** Hole 1: the child carries no tenant, so the guard has nothing to scope it by. */
const tpChildRead = action({
  input: byFile,
  output: Url,
  policy: can('tp:read'),
  async handle({ input }) {
    const file = await files().findById(input.tpFileId);
    return file === null ? missing('file') : { url: file.url };
  },
});

/** Hole 2 is SQL and lives in `tenant-proof-sql-fixture.ts`. Hole 3: a support sweep's escape. */
const tpCrossRead = action({
  input: byVault,
  output: Label,
  policy: can('tp:read'),
  async handle({ input }) {
    const support = serviceActor({ id: 'tp-support', scopes: [CROSS_TENANT_SCOPE] });
    const vault = await withChildContext({ actor: support }, () =>
      crossTenant('support reads any vault', () => vaults().findById(input.tpVaultId)),
    );
    return vault === null ? missing('vault') : { label: vault.label };
  },
});

/** Hole 4: a service actor minted from the INPUT's org, so the guard scopes to the caller's pick. */
const tpServiceRead = action({
  input: t.object({ orgId: t.uuid, tpVaultId: t.uuid }),
  output: Label,
  policy: can('tp:read'),
  async handle({ input }) {
    const indexer = serviceActor({ id: 'tp-indexer', orgId: input.orgId });
    const vault = await withChildContext({ actor: indexer }, () =>
      vaults().findById(input.tpVaultId),
    );
    return vault === null ? missing('vault') : { label: vault.label };
  },
});

/** Hole 5: the read is scoped, its cache key is not — whoever fills it, everyone reads it. */
const tpCachedRead = action({
  input: byVault,
  output: Label,
  policy: can('tp:read'),
  async handle({ input }) {
    const hit = tpLabelCache.get(input.tpVaultId);
    if (hit !== undefined) return { label: hit };
    const vault = await vaults().findById(input.tpVaultId);
    if (vault === null) return missing('vault');
    tpLabelCache.set(input.tpVaultId, vault.label);
    return { label: vault.label };
  },
});

/** Hole 6: answers nothing of A's, but MAILS A's owner — the leak is the envelope alone. */
const tpMailOwner = action({
  input: byFile,
  output: Ok,
  policy: can('tp:write'),
  async handle({ input }) {
    const file = await files().findById(input.tpFileId);
    if (file === null) return missing('file');
    await send(
      tpNotice,
      { ok: true },
      { to: `${file.owner}@tenant.example.test`, locale: 'en', sync: true },
    );
    return { ok: true };
  },
});

/** Hole 7: a write by input id on the tenantless child. */
const tpRenameFile = action({
  input: byFile,
  output: Ok,
  policy: can('tp:write'),
  async handle({ input }) {
    await files().update(input.tpFileId, { url: 'https://renamed.example.test/by-caller' });
    return { ok: true };
  },
});

/** Green: the guard scopes the parent, so B's id answers not-found and A's answers A. */
const tpScopedRead = action({
  input: byVault,
  output: Label,
  policy: can('tp:read'),
  async handle({ input }) {
    const vault = await vaults().findById(input.tpVaultId);
    return vault === null ? missing('vault') : { label: vault.label };
  },
});

/** Public by its own declaration: the same child read as hole 1, admitted to anonymous. */
const tpPublicFile = action({
  input: byFile,
  output: Url,
  policy: allow(),
  async handle({ input }) {
    const file = await files().findById(input.tpFileId);
    return file === null ? missing('file') : { url: file.url };
  },
});

/** Public, and a write by input id: the read half is skipped, the write half is not. */
const tpPublicRename = action({
  input: byFile,
  output: Ok,
  policy: allow(),
  async handle({ input }) {
    await files().update(input.tpFileId, { url: 'https://renamed.example.test/by-anyone' });
    return { ok: true };
  },
});

/** A declared-shared child read by id: nobody's row, so no tenant's leak. */
const tpLinkRead = action({
  input: t.object({ tpLinkId: t.uuid }),
  output: t.object({ slug: t.string }),
  policy: can('tp:read'),
  async handle({ input }) {
    const link = await tpDriver.repo(tpLinks).findById(input.tpLinkId);
    return link === null ? missing('link') : { slug: link.slug };
  },
});

/** Never reaches its body's end: nothing was proven, so nothing may read proven. */
const tpAlwaysThrows = action({
  input: byVault,
  output: Label,
  policy: can('tp:read'),
  handle: () => Promise.reject(new TypeError('the handler broke')),
});

registerActions({
  tpAlwaysThrows,
  tpCachedRead,
  tpChildRead,
  tpCrossRead,
  tpLinkRead,
  tpMailOwner,
  tpPublicFile,
  tpPublicRename,
  tpRenameFile,
  tpScopedRead,
  tpServiceRead,
});

/** Hole 1 as a QUERY: the same unscoped child, on the second of the three walked lists. */
registerQueries({
  tpChildQuery: query({
    input: byFile,
    policy: can('tp:read'),
    sql: (input) =>
      from<{ id: string; url: string }>('tp_files', async () => {
        const file = await files().findById(input.tpFileId);
        return file === null ? [] : [{ id: file.id, url: file.url }];
      }),
  }),
});

/**
 * Hole 7 as a JOB: the worker writes the child by the enqueued id, whoever enqueued it. Declared
 * `tenant: 'none'` — a payload naming an org is refused at the enqueue when it disagrees with the
 * enqueuer's (`X_JOB_TENANT_MISMATCH`), so the hole that survives is the job claiming no tenant.
 */
job({
  name: 'tpRenameFileJob',
  tenant: 'none',
  input: byFile,
  idempotencyKey: (input) => input.tpFileId,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async ({ input }) => {
    await files().update(input.tpFileId, { url: 'https://renamed.example.test/by-worker' });
  },
});
