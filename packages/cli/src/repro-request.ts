// Single responsibility: a captured request bundle as the `.contract.test.ts` that replays it —
// rows seeded through the app's own driver, the clock frozen at the failure, the actor and input
// as captured. Pure: the read is `repro-bundle.ts`', the write `repro-write.ts`'.

import type { FailureBundle } from '@ultimat3/core';
import type { ReproSourceMeta } from './repro-job';
import { header } from './repro-job';
import { tsLiteral } from './repro-literal';

export interface RequestSourceMeta extends ReproSourceMeta {
  /** `@<app>/db` — the package exporting `driver`; `null` when the app has none (no rows seeded). */
  readonly dbPackage: string | null;
  /** The build that is about to run the test, to say so when it is not the captured one. */
  readonly build: string | null;
}

export function requestTestSource(bundle: FailureBundle, meta: RequestSourceMeta): string {
  const masked = bundle.masked.length === 0 ? 'none' : bundle.masked.join(', ');
  const drift =
    bundle.build !== null && meta.build !== null && bundle.build !== meta.build
      ? `Captured on build ${bundle.build}, replayed on ${meta.build}: a different outcome may be the fix already shipped.`
      : `Captured on build ${bundle.build ?? 'unknown'}.`;
  const lines = [
    `x repro ${meta.id}: ${bundle.primitive} "${bundle.name}" answered ${bundle.code} (fingerprint ${bundle.fingerprint}).`,
    'Written by `x repro --write`. Red until the fault is fixed: the rows it read are seeded, the',
    'clock is frozen at the failure, and it runs again as the same actor with the same input.',
    `Masked input fields (${masked}) are stood in for from the schema. ${drift}`,
    ...(bundle.truncated
      ? ['The bundle was truncated at capture: some rows it read are not here.']
      : []),
  ];
  const driverImport =
    meta.dbPackage === null ? '' : `import { driver } from '${meta.dbPackage}';\n`;
  const options = meta.dbPackage === null ? '' : ', { driver }';
  return `${header(lines)}

import type { FailureBundle } from '@ultimat3/core';
import { expect, reproduce, test } from '@ultimat3/testing';
${driverImport}${meta.imports.map((specifier) => `import '${specifier}';`).join('\n')}

const BUNDLE: FailureBundle = ${tsLiteral(bundle)};

test(${tsLiteral(`repro ${meta.id.slice(0, 8)}: ${bundle.name} answers without ${bundle.code}`)}, async () => {
  const outcome = await reproduce(BUNDLE${options});
  expect(outcome.failure).toBeNull();
});
`;
}
