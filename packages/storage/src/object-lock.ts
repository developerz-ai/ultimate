// Single responsibility: S3 Object Lock as this package's vocabulary — a per-object retention (a
// mode and an instant) and a legal hold, the screen `put()` holds them to, the one "is it locked
// now?" rule, and the refusals the disks that EMULATE a lock (local, memory) answer with.

import {
  assert,
  type Clock,
  describeValue,
  renderFixLiteral,
  renderFixShellArg,
} from '@ultimat3/core';
import { StorageError } from './errors';

/** `GOVERNANCE` yields to `s3:BypassGovernanceRetention`; `COMPLIANCE` yields to nobody, root included. */
export const RETENTION_MODES = ['GOVERNANCE', 'COMPLIANCE'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export interface ObjectRetention {
  readonly mode: RetentionMode;
  /** The instant the lock lapses. UTC-backed; sent as an ISO-8601 instant. */
  readonly retainUntil: Date;
}

/** What locks one object, as the disk reports it. Neither field set means nothing locks it. */
export interface ObjectLock {
  readonly retention?: ObjectRetention | undefined;
  readonly legalHold: boolean;
}

/** The lock half of `PutOptions`, screened here so all three disks refuse one way. */
export interface ObjectLockOptions {
  readonly retention?: ObjectRetention | undefined;
  readonly legalHold?: boolean | undefined;
}

export const isRetentionMode = (value: unknown): value is RetentionMode =>
  (RETENTION_MODES as readonly unknown[]).includes(value);

/**
 * A retention whose mode is not one of the two, whose instant is not one, or whose instant has
 * already passed — refused before a byte moves. S3 itself answers a past date with a 400; the
 * local disk would store a lock that never held, which reads to a caller as "this is retained".
 */
export function assertObjectLockOptions(
  driver: string,
  options: ObjectLockOptions | undefined,
  clock: Clock,
): void {
  const retention = options?.retention;
  if (retention !== undefined) {
    assert(
      isRetentionMode(retention.mode),
      `put() on the ${driver} disk was given a retention mode that is neither GOVERNANCE nor COMPLIANCE (${describeValue(retention.mode)})`,
      "put(key, body, { retention: { mode: 'GOVERNANCE', retainUntil } })",
    );
    const until = retention.retainUntil;
    assert(
      until instanceof Date && Number.isFinite(until.getTime()),
      `put() on the ${driver} disk was given a retainUntil that is not a valid Date (${describeValue(until)})`,
      'put(key, body, { retention: { mode, retainUntil: new Date(clock.now().getTime() + days * 86_400_000) } })',
    );
    assert(
      until.getTime() > clock.now().getTime(),
      `put() on the ${driver} disk was given a retainUntil of ${until.toISOString()}, which is not in the future: a lock that has already lapsed retains nothing`,
      'pass a retainUntil after now — new Date(clock.now().getTime() + days * 86_400_000)',
    );
  }
  assert(
    options?.legalHold === undefined || typeof options.legalHold === 'boolean',
    `put() on the ${driver} disk was given a legalHold that is not a boolean (${describeValue(options?.legalHold)})`,
    'put(key, body, { legalHold: true }) — or omit legalHold',
  );
}

/** The lock `put()` was asked to set, in the shape a disk stores — `undefined` when none was. */
export function requestedLock(options: ObjectLockOptions | undefined): ObjectLock | undefined {
  if (options?.retention === undefined && options?.legalHold !== true) return undefined;
  return {
    ...(options.retention === undefined
      ? {}
      : {
          retention: {
            mode: options.retention.mode,
            retainUntil: new Date(options.retention.retainUntil.getTime()),
          },
        }),
    legalHold: options.legalHold === true,
  };
}

/** Locked NOW: a legal hold, or a retention whose instant is still ahead. One rule, every disk. */
export function isLocked(lock: ObjectLock | undefined, now: Date): boolean {
  if (lock === undefined) return false;
  if (lock.legalHold) return true;
  return lock.retention !== undefined && lock.retention.retainUntil.getTime() > now.getTime();
}

function describeLock(lock: ObjectLock): string {
  const parts: string[] = [];
  if (lock.retention !== undefined) {
    parts.push(
      `${lock.retention.mode} retention until ${lock.retention.retainUntil.toISOString()}`,
    );
  }
  if (lock.legalHold) parts.push('a legal hold');
  return parts.join(' and ');
}

export type LockedAction = 'delete' | 'overwrite' | 'copy onto';

/**
 * The fix opens with the read that shows the lock, then where the bytes can go instead. An
 * overwrite or a copy has another key to write to; a delete only has "later".
 */
function lockFix(
  action: LockedAction,
  disk: string,
  key: string,
  lock: ObjectLock,
  sidecar: string | undefined,
): string {
  const show = `disk('${disk}').retentionOf(${renderFixLiteral(key, '"<key>"')}) # shows the lock`;
  const elsewhere =
    action === 'delete'
      ? ''
      : `; or write under a new key: disk('${disk}').put(${renderFixLiteral(`${key}.v2`, '"<a new key>"')}, body)`;
  if (lock.legalHold) {
    return sidecar === undefined
      ? `${show}; a hold on the memory disk lasts as long as the process${elsewhere}`
      : `${show}; release the hold by setting "legalHold": false in ${renderFixShellArg(sidecar, "'<the sidecar file>'")}${elsewhere}`;
  }
  const until = lock.retention?.retainUntil.toISOString() ?? 'the retention lapses';
  return `${show}; retry after ${until}${elsewhere}`;
}

/**
 * `X_STORAGE_OBJECT_LOCKED` — a delete, overwrite or copy onto a locked key, refused by a disk that
 * EMULATES Object Lock (local, memory). Those disks keep ONE version per key, so refusing is the
 * only way to keep the locked bytes; S3 keeps the locked VERSION and lets the call through (a
 * delete marker, a newer version) — `driver-parity.test.ts` pins that divergence.
 */
export class ObjectLockedError extends StorageError {
  readonly lock: ObjectLock;

  constructor(input: {
    readonly disk: string;
    readonly key: string;
    readonly action: LockedAction;
    readonly lock: ObjectLock;
    /** The local disk's sidecar path, where a legal hold is released; absent on memory. */
    readonly sidecar?: string | undefined;
  }) {
    const { disk, key, action, lock, sidecar } = input;
    super({
      code: 'X_STORAGE_OBJECT_LOCKED',
      cause: `disk "${disk}" refused to ${action} "${key}": it is under ${describeLock(lock)}; the stored bytes are unchanged`,
      fix: lockFix(action, disk, key, lock, sidecar),
      meta: {
        disk,
        key,
        action,
        legalHold: lock.legalHold,
        ...(lock.retention === undefined
          ? {}
          : {
              mode: lock.retention.mode,
              retainUntil: lock.retention.retainUntil.toISOString(),
            }),
      },
    });
    this.lock = lock;
  }
}
