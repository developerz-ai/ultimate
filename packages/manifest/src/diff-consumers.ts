// `consumer()` declarations in a contract diff. Its job and its supervisor task are judged by
// `diff-work.ts` already; this file sees the one fact neither does — that a stream stopped being
// read. Removal is breaking (nothing throws, the cursor simply stops); every other field internal.

import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { ConsumerFact } from './schema';

const FIELDS = ['queue', 'supervisor', 'arm', 'rearm', 'batch', 'lags'] as const;

export function diffConsumers(
  before: readonly ConsumerFact[],
  after: readonly ConsumerFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (consumer) => consumer.name);
  const beforeByName = index(before, (consumer) => consumer.name);

  for (const consumer of before) {
    const path = `consumers.${consumer.name}`;
    const next = afterByName.get(consumer.name);
    if (next === undefined) {
      changes.push({
        kind: 'breaking',
        path,
        detail: 'consumer removed; its stream is never read',
      });
      continue;
    }
    for (const field of FIELDS) {
      changes.push(...diffScalar('internal', `${path}.${field}`, consumer[field], next[field]));
    }
  }
  for (const consumer of after) {
    if (!beforeByName.has(consumer.name)) {
      changes.push({
        kind: 'additive',
        path: `consumers.${consumer.name}`,
        detail: 'consumer added',
      });
    }
  }
  return changes;
}
