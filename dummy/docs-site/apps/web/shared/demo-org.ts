// The org every development-only fact belongs to: the dev actor's `orgId`, the org the seed
// writes its rows under, and the org the dashboard aggregates. One constant, so the three cannot
// disagree — a policy deciding `actor.orgId === input.orgId` passes for the dev actor on the rows
// the seed wrote. Replace its readers when this app issues real sessions.
import { seedId } from '@ultimat3/entity';

/** The label `defineSeed`'s `id()` derives the uuid from — the same uuid on every run. */
export const DEMO_ORG_LABEL = 'org:demo';

/** `seedId(DEMO_ORG_LABEL)`: a uuid v5, exactly what the seed's `id(DEMO_ORG_LABEL)` answers. */
export const DEMO_ORG_ID = seedId(DEMO_ORG_LABEL);
