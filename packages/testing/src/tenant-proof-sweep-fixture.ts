// Two nightly sweeps on `tenant-proof-fixture.ts`'s memory app, both `tenant: 'none'` and both
// handing every org's rows on: one DECLARES the crossing with `crossTenant()` and is a sweep, the
// other reaches the tenantless child with no scope at all and is a leak. Registered at module scope.

import { serviceActor, withChildContext } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';
import { DEFAULT_RETRY, job, t } from '@ultimat3/jobs';
import { tpDriver, tpFiles, tpVaults } from './tenant-proof-fixture';

const nightly = t.object({ night: t.string });
const once = { ...DEFAULT_RETRY, attempts: 1 };

/** `sendDigest`'s shape: a minted sweeper, a written reason, every org's rows in the answer. */
job({
  name: 'tpVaultSweep',
  tenant: 'none',
  input: nightly,
  idempotencyKey: (input) => input.night,
  retry: once,
  run: async () => {
    const sweeper = serviceActor({ id: 'tp-sweeper', scopes: [CROSS_TENANT_SCOPE] });
    const page = await withChildContext({ actor: sweeper }, () =>
      crossTenant('the nightly vault report covers every org', () =>
        tpDriver.repo(tpVaults).findMany({ limit: 100 }),
      ),
    );
    return { labels: page.rows.map((vault) => vault.label) };
  },
});

/** The same sweep with no declaration: the tenantless child lets it past the guard unannounced. */
job({
  name: 'tpFileSweep',
  tenant: 'none',
  input: nightly,
  idempotencyKey: (input) => input.night,
  retry: once,
  run: async () => {
    const page = await tpDriver.repo(tpFiles).findMany({ limit: 100 });
    return { urls: page.rows.map((file) => file.url) };
  },
});
