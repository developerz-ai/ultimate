// The statements ONE call sends, as `x explain` plans them: every `db.statement` event the call
// made under a marker of its own (never by time — the bus is process-wide), its text whitespace
// collapsed and its `expectedSeqScan` reason kept, exactly as the exercise room records them.

import { asyncContext, subscribe } from '@ultimat3/core';
import { expectedSeqScanReason } from '@ultimat3/db';
import type { SentStatement } from '@ultimat3/testing';

const scope = asyncContext<object>('x explain');

export interface Captured<T> {
  readonly value: T;
  /** Statement text → who sent it and why it may scan, in the shape `sweepPlans` reads. */
  readonly sent: ReadonlyMap<string, SentStatement>;
}

export async function captureStatements<T>(
  subject: string,
  fn: () => Promise<T>,
): Promise<Captured<T>> {
  const marker = {};
  const sent = new Map<string, { primitives: Set<string>; scan?: string }>();
  // The bus delivers synchronously in the sender's context, so the marker read is the sender's.
  const off = subscribe('db.statement', (event) => {
    if (scope.get() !== marker) return;
    const text = event.payload.text.replace(/\s+/g, ' ').trim();
    const one = sent.get(text) ?? { primitives: new Set([subject]) };
    const scan = expectedSeqScanReason();
    if (scan !== undefined) one.scan = scan;
    sent.set(text, one);
  });
  try {
    const value = await scope.run(marker, fn);
    return { value, sent };
  } finally {
    off();
  }
}
