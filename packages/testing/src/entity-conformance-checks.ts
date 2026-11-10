// Every entity conformance check, in one ordered list: the suite runs them in this order, one
// test each. Grouped by the file that states them; a new group is one import and one spread here.

import { AGGREGATE_CHECKS } from './entity-conformance-aggregates';
import { BATCH_CHECKS } from './entity-conformance-batches';
import { BULK_CHECKS } from './entity-conformance-bulk';
import { LOCK_CHECKS } from './entity-conformance-locks';
import { MATRIX_CHECKS } from './entity-conformance-matrix';
import { READ_CHECKS } from './entity-conformance-reads';
import { TENANCY_CHECKS } from './entity-conformance-tenancy';
import { VALUE_CHECKS } from './entity-conformance-values';
import { VERSION_CHECKS } from './entity-conformance-versions';
import { WRITE_CHECKS } from './entity-conformance-writes';
import type { EntityDriverCheck } from './entity-driver-conformance';

export const ENTITY_DRIVER_CHECKS: readonly EntityDriverCheck[] = [
  ...WRITE_CHECKS,
  ...VALUE_CHECKS,
  ...READ_CHECKS,
  ...BULK_CHECKS,
  ...AGGREGATE_CHECKS,
  ...TENANCY_CHECKS,
  ...BATCH_CHECKS,
  ...LOCK_CHECKS,
  ...MATRIX_CHECKS,
  ...VERSION_CHECKS,
];
