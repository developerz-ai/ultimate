// A record group commit has ACCEPTED: one object per `write()`, carrying the row id minted at that
// moment, handed to `writeMany` and to the single retry alike — so a sink can tell "this record
// again" (a batch that stored its rows and lost its reply) from "another attempt with the same facts".

import { uuidV7 } from '@ultimat3/core';
import type { AuditRecord } from './audit';

/**
 * Keyed by the accepted COPY, never the caller's record: the conformance contract
 * (`auditSinkConformance`, "two identical attempts are two records") writes one object twice and
 * expects two rows, so the caller's object is not an identity. Each acceptance is a fresh copy.
 */
const accepted = new WeakMap<AuditRecord, string>();

/** One accepted write: a shallow copy of `record` and its row id, minted here and only here. */
export function acceptRecord(record: AuditRecord): AuditRecord {
  const copy: AuditRecord = { ...record };
  accepted.set(copy, uuidV7());
  return copy;
}

/** The id minted when `record` was accepted, or `undefined` for a record no batch accepted. */
export function acceptedIdOf(record: AuditRecord): string | undefined {
  return accepted.get(record);
}
