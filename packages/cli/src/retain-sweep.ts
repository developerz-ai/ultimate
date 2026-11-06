// The `manifest` step's retention half: an entity declaring `retain` that no `purge()` covers is a
// promise nothing keeps — rows past the window are never deleted, and nobody finds out until an
// audit. `X_ENTITY_RETAIN_UNSWEPT` makes it a build error (axiom 3).

import { unsweptEntities } from '@ultimat3/jobs';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';

export function retainUnsweptFinding(entity: string): Finding {
  return {
    code: 'X_ENTITY_RETAIN_UNSWEPT',
    cause: `entity "${entity}" declares retain, and no purge() registered in this app sweeps it — rows past its window are kept forever`,
    fix: "export const retention = purge({ entities: 'declared' }) — in a jobs module named in jobs: [...] in apps/web/api/index.ts, then x verify",
    at: 'apps/web/api/index.ts',
  };
}

/** The step's answer, after the app loaded — a short registry is the load's finding, not this one. */
export async function retainUnsweptFindings(
  root: string,
  load: AppLoader = loadApp,
  unswept: () => readonly string[] = unsweptEntities,
): Promise<readonly Finding[]> {
  if ((await load(root)).findings.length > 0) return [];
  return unswept().map(retainUnsweptFinding);
}
