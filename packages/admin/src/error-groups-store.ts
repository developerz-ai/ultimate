// Single responsibility: what an error GROUP is — one row per `errorFingerprint`, first and last
// seen, a count and one redacted sample — the store seam that keeps them, and its memory twin. The
// Postgres store is `error-groups-pg.ts`; the sink that feeds either is `error-groups-sink.ts`.

import { finiteCount } from '@ultimat3/core';
import type { PurgeTarget } from '@ultimat3/jobs';
import { ERROR_GROUPS_TABLE } from './error-groups-schema';

/** Triage state. `resolved` re-opens on the next occurrence; `ignored` stays ignored. */
export const ERROR_GROUP_STATUSES = ['open', 'resolved', 'ignored'] as const;

export type ErrorGroupStatus = (typeof ERROR_GROUP_STATUSES)[number];

/** One report, kept as the group's example: already redacted, never the thrown value. */
export interface ErrorGroupSample {
  readonly at: string;
  readonly severity: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly release: string | null;
  readonly environment: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly meta: Readonly<Record<string, unknown>> | null;
  readonly stack: string | null;
}

/** What the sink hands a store: `count` reports of one group, the newest at `at`. */
export interface ErrorGroupOccurrence {
  readonly fingerprint: string;
  readonly code: string;
  readonly source: string;
  readonly operation: string | null;
  /** The cause's head, the line a list shows. */
  readonly message: string;
  readonly at: Date;
  readonly count: number;
  readonly sample: ErrorGroupSample;
}

export interface ErrorGroup {
  readonly fingerprint: string;
  readonly code: string;
  readonly source: string;
  readonly operation: string | null;
  readonly message: string;
  readonly status: ErrorGroupStatus;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly count: number;
  readonly sample: ErrorGroupSample;
}

export interface ErrorGroupsQuery {
  readonly status?: ErrorGroupStatus | undefined;
  /** Newest-seen first. Default 50, at most `ERROR_GROUPS_MAX_LIMIT`. */
  readonly limit?: number | undefined;
}

export const ERROR_GROUPS_DEFAULT_LIMIT = 50;
export const ERROR_GROUPS_MAX_LIMIT = 500;

export interface ErrorGroupsStore {
  readonly kind: 'memory' | 'postgres';
  /**
   * Upsert on the fingerprint. `isNew` is true for exactly ONE caller per group, however many
   * replicas raced to insert it — the answer `onNewGroup` is enqueued on.
   */
  record(occurrence: ErrorGroupOccurrence): Promise<{ readonly isNew: boolean }>;
  list(query?: ErrorGroupsQuery): Promise<readonly ErrorGroup[]>;
  get(fingerprint: string): Promise<ErrorGroup | undefined>;
  /** The group after the change, or `undefined` when there is no such group. */
  setStatus(fingerprint: string, status: ErrorGroupStatus): Promise<ErrorGroup | undefined>;
  /** Deletes every group last seen before `beforeMs` (epoch ms); answers how many went. */
  purge(beforeMs: number): Promise<number>;
}

/** The list limit, screened: a `NaN` here is `slice(0, NaN)`, an empty screen that looks fine. */
export function errorGroupsLimit(subject: string, limit: number | undefined): number {
  const asked = finiteCount(subject, 'limit', limit ?? ERROR_GROUPS_DEFAULT_LIMIT, 1);
  return Math.min(asked, ERROR_GROUPS_MAX_LIMIT);
}

/** `resolved` → `open` on a new occurrence: a fault that came back is a regression to look at. */
export const statusAfterOccurrence = (status: ErrorGroupStatus): ErrorGroupStatus =>
  status === 'resolved' ? 'open' : status;

/** For tests and `x dev`: one process's heap, held to the same contract as the Postgres store. */
export function memoryErrorGroupsStore(): ErrorGroupsStore {
  const groups = new Map<string, ErrorGroup>();
  return {
    kind: 'memory',
    async record(occurrence) {
      const at = occurrence.at.toISOString();
      const seen = groups.get(occurrence.fingerprint);
      if (seen === undefined) {
        groups.set(occurrence.fingerprint, {
          fingerprint: occurrence.fingerprint,
          code: occurrence.code,
          source: occurrence.source,
          operation: occurrence.operation,
          message: occurrence.message,
          status: 'open',
          firstSeen: at,
          lastSeen: at,
          count: occurrence.count,
          sample: occurrence.sample,
        });
        return { isNew: true };
      }
      groups.set(occurrence.fingerprint, {
        ...seen,
        message: occurrence.message,
        status: statusAfterOccurrence(seen.status),
        lastSeen: at > seen.lastSeen ? at : seen.lastSeen,
        count: seen.count + occurrence.count,
        sample: occurrence.sample,
      });
      return { isNew: false };
    },
    async list(query = {}) {
      const limit = errorGroupsLimit('memoryErrorGroupsStore', query.limit);
      return [...groups.values()]
        .filter((group) => query.status === undefined || group.status === query.status)
        .sort((a, b) =>
          a.lastSeen === b.lastSeen
            ? a.fingerprint.localeCompare(b.fingerprint)
            : a.lastSeen < b.lastSeen
              ? 1
              : -1,
        )
        .slice(0, limit);
    },
    async get(fingerprint) {
      return groups.get(fingerprint);
    },
    async setStatus(fingerprint, status) {
      const seen = groups.get(fingerprint);
      if (seen === undefined) return undefined;
      const next = { ...seen, status };
      groups.set(fingerprint, next);
      return next;
    },
    async purge(beforeMs) {
      const before = new Date(beforeMs).toISOString();
      let removed = 0;
      for (const [fingerprint, group] of groups) {
        if (group.lastSeen >= before) continue;
        groups.delete(fingerprint);
        removed += 1;
      }
      return removed;
    },
  };
}

export interface ErrorGroupsPurgeOptions {
  /** REQUIRED: how long a group nobody has seen again is kept is the app's decision. */
  readonly olderThanMs: number;
}

/** The sweep `purgeJob` runs: groups last seen more than `olderThanMs` before the job's clock. */
export function errorGroupsPurgeTarget(
  store: ErrorGroupsStore,
  options: ErrorGroupsPurgeOptions,
): PurgeTarget {
  const olderThanMs = finiteCount('errorGroupsPurgeTarget', 'olderThanMs', options.olderThanMs, 1);
  return {
    name: ERROR_GROUPS_TABLE,
    purgeExpired: (nowMs) => store.purge(nowMs - olderThanMs),
  };
}
