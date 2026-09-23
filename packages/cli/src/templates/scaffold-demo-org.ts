// `apps/web/shared/demo-org.ts`: the ONE org this app has until it issues sessions. The dev actor
// named `'dev-org'`, the seed wrote `id('org:demo')` and the dashboard computed a third copy — so a
// generated tenant policy (`actor.orgId === input.orgId`, a `t.uuid`) could never pass for the dev
// actor, and every generated write answered 403 under a green gate.

import type { GeneratedFile } from './naming';

const demoOrg =
  (): string => `// The org every development-only fact belongs to: the dev actor's \`orgId\`, the org the seed
// writes its rows under, and the org the dashboard aggregates. One constant, so the three cannot
// disagree — a policy deciding \`actor.orgId === input.orgId\` passes for the dev actor on the rows
// the seed wrote. Replace its readers when this app issues real sessions.
import { seedId } from '@ultimat3/entity';

/** The label \`defineSeed\`'s \`id()\` derives the uuid from — the same uuid on every run. */
export const DEMO_ORG_LABEL = 'org:demo';

/** \`seedId(DEMO_ORG_LABEL)\`: a uuid v5, exactly what the seed's \`id(DEMO_ORG_LABEL)\` answers. */
export const DEMO_ORG_ID = seedId(DEMO_ORG_LABEL);
`;

const demoOrgTest =
  (): string => `// The dev actor, the seed and the dashboard all read DEMO_ORG_ID. If it stops being the uuid the
// seed's \`id()\` derives, a generated tenant policy denies the dev actor again.
import { seedId } from '@ultimat3/entity';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID, DEMO_ORG_LABEL } from './demo-org';

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

unitTest('the demo org is the uuid the seed writes', () => {
  expect(DEMO_ORG_ID).toBe(seedId(DEMO_ORG_LABEL));
  expect(DEMO_ORG_ID).toMatch(UUID_V5);
});
`;

/** Written by `x new`, with or without the example slice: the dev actor always reads it. */
export const demoOrgFiles = (): readonly GeneratedFile[] => [
  { path: 'apps/web/shared/demo-org.ts', contents: demoOrg() },
  { path: 'apps/web/shared/demo-org.test.ts', contents: demoOrgTest() },
];
