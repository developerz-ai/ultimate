// An action or query an app module exports and no `defineApi()` lists: still served by the scan,
// so never refused, but warned with the import line that lists it — the line X_JOB_UNREGISTERED
// prints for a job, which the same gap does refuse.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove API, and no path joiner.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetActions } from '@ultimat3/action';
import { resetQueries } from '@ultimat3/query';
import { unlistedPrimitiveFindings } from './doctor-api-listing';

const resolved = (specifier: string): string => JSON.stringify(import.meta.resolve(specifier));

const actionModule = (
  name: string,
): string => `import { action } from ${resolved('@ultimat3/action')};
import { allow } from ${resolved('@ultimat3/policy')};
import { t } from ${resolved('@ultimat3/schema')};
export const ${name} = action({
  input: t.object({}),
  output: t.object({}),
  policy: allow('public'),
  async handle() { return {}; },
});
`;

const queryModule = `import { allow } from ${resolved('@ultimat3/policy')};
import { from, query, t } from ${resolved('@ultimat3/query')};
export const ticketCount = query({
  input: t.object({}),
  policy: allow('public'),
  sql: () => from<{ id: string }>('tickets', []).orderBy('id').limit(1),
});
`;

const FILES = {
  listed: 'apps/web/app/ticket/actions/close-ticket.ts',
  unlisted: 'apps/web/app/ticket/actions/refund-ticket.ts',
  query: 'apps/web/app/ticket/queries/ticket-count.ts',
} as const;

const dirs: string[] = [];
afterEach(async () => {
  resetActions();
  resetQueries();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const LISTS_ONE = `import { defineApi } from ${resolved('@ultimat3/action')};
import * as closeTicket from '../app/ticket/actions/close-ticket';
export const api = defineApi({ actions: [closeTicket] });
`;

/** An app whose index lists one of its two actions and none of its queries. */
async function app(index = LISTS_ONE): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doctor-api-listing-'));
  dirs.push(dir);
  await Bun.write(join(dir, FILES.listed), actionModule('closeTicket'));
  await Bun.write(join(dir, FILES.unlisted), actionModule('refundTicket'));
  await Bun.write(join(dir, FILES.query), queryModule);
  await Bun.write(join(dir, 'apps/web/api/index.ts'), index);
  return dir;
}

const loaded = async () => ({ findings: [], files: Object.values(FILES) });

describe('unit · x doctor warns of a primitive no defineApi() lists', () => {
  test('the unlisted action and query, each with the import line that lists it', async () => {
    const findings = await unlistedPrimitiveFindings(await app(), loaded);
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_ACTION_UNREGISTERED', FILES.unlisted],
      ['X_QUERY_UNREGISTERED', FILES.query],
    ]);
    const [action, query] = findings;
    expect(action?.cause).toContain('refundTicket');
    expect(action?.fix).toStartWith(
      "import * as refundTicket from '../app/ticket/actions/refund-ticket';",
    );
    expect(action?.fix).toContain('refundTicket added to actions: [...] there');
    expect(query?.fix).toContain('ticketCount added to queries: [...] there');
  });

  test('a load that failed says nothing: the short registry is the load’s finding', async () => {
    const failed = async () => ({
      findings: [{ code: 'X_APP_IMPORT_UNRESOLVED', cause: 'c', fix: 'f' }],
      files: Object.values(FILES),
    });
    expect(await unlistedPrimitiveFindings(await app(), failed)).toEqual([]);
  });

  // A supported shape, not a gap: an app that registers by the module scan alone
  // (dummy/social-media-clone) lists nothing anywhere, so there is nothing to be inconsistent with.
  test('an app that lists no action or query anywhere is warned of nothing', async () => {
    const scanOnly = 'export const seeded = true;\n';
    expect(await unlistedPrimitiveFindings(await app(scanOnly), loaded)).toEqual([]);
    const listsNone = `import { defineApi } from ${resolved('@ultimat3/action')};
export const api = defineApi({});
`;
    expect(await unlistedPrimitiveFindings(await app(listsNone), loaded)).toEqual([]);
  });
});
