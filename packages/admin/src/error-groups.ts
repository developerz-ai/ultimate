// `@ultimat3/admin/error-groups` — the error-groups sink and its two stores, and nothing else:
// the sink is an `ErrorReporter` EVERY role installs (a worker's failures are grouped too), so it
// must load without one admin screen. The screens are `errorGroupsPages` on the main barrel.

export { type PostgresErrorGroupsStoreOptions, postgresErrorGroupsStore } from './error-groups-pg';
export {
  ERROR_GROUPS_PER_MINUTE,
  type ErrorGroupNotice,
  type ErrorGroupsSink,
  type ErrorGroupsSinkOptions,
  errorGroupsSink,
} from './error-groups-sink';
export {
  ERROR_GROUP_STATUSES,
  type ErrorGroup,
  type ErrorGroupOccurrence,
  type ErrorGroupSample,
  type ErrorGroupStatus,
  type ErrorGroupsPurgeOptions,
  type ErrorGroupsQuery,
  type ErrorGroupsStore,
  errorGroupsPurgeTarget,
  memoryErrorGroupsStore,
} from './error-groups-store';
