// Every entity conformance check, in one ordered list: the suite runs them in this order, one
// test each. Grouped by the file that states them; a new group is one import and one spread here.

import { AGGREGATE_CHECKS } from './entity-conformance-aggregates';
import { BATCH_CHECKS } from './entity-conformance-batches';
import { BULK_CHECKS } from './entity-conformance-bulk';
import { CHAIN_WRITE_CHECKS } from './entity-conformance-chain-writes';
import { CONTAINS_CHECKS } from './entity-conformance-contains';
import { COUNTED_IN_CHECKS } from './entity-conformance-counted-in';
import { HISTORY_CHECKS } from './entity-conformance-history';
import { LATEST_BY_CHECKS } from './entity-conformance-latest-by';
import { LOCK_KEYS_CHECKS } from './entity-conformance-lock-keys';
import { LOCK_CHECKS } from './entity-conformance-locks';
import { MATRIX_CHECKS } from './entity-conformance-matrix';
import { MATRIX_WRITE_CHECKS } from './entity-conformance-matrix-writes';
import { MEASURE_CHECKS } from './entity-conformance-measures';
import { PAGE_BYTE_CHECKS } from './entity-conformance-page-bytes';
import { READ_CHECKS } from './entity-conformance-reads';
import { TENANCY_CHECKS } from './entity-conformance-tenancy';
import { UNRETURNED_CHECKS } from './entity-conformance-unreturned';
import { UPDATE_MANY_CHECKS } from './entity-conformance-update-many';
import { VALUE_CHECKS } from './entity-conformance-values';
import { VERSION_LOCK_CHECKS } from './entity-conformance-version-lock';
import { VERSION_CHECKS } from './entity-conformance-versions';
import { WRITE_CHECKS } from './entity-conformance-writes';
import type { EntityDriverCheck } from './entity-driver-conformance';

export const ENTITY_DRIVER_CHECKS: readonly EntityDriverCheck[] = [
  ...WRITE_CHECKS,
  ...VALUE_CHECKS,
  ...READ_CHECKS,
  ...PAGE_BYTE_CHECKS,
  ...BULK_CHECKS,
  ...CHAIN_WRITE_CHECKS,
  ...UPDATE_MANY_CHECKS,
  ...UNRETURNED_CHECKS,
  ...AGGREGATE_CHECKS,
  ...MEASURE_CHECKS,
  ...CONTAINS_CHECKS,
  ...TENANCY_CHECKS,
  ...BATCH_CHECKS,
  ...LATEST_BY_CHECKS,
  ...LOCK_CHECKS,
  ...LOCK_KEYS_CHECKS,
  ...MATRIX_CHECKS,
  ...MATRIX_WRITE_CHECKS,
  ...VERSION_CHECKS,
  ...VERSION_LOCK_CHECKS,
  ...HISTORY_CHECKS,
  ...COUNTED_IN_CHECKS,
];
