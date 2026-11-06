// Single responsibility: the read half of failure capture — a row a repository answered, into
// `@ultimat3/core`'s buffer while a captured call is in flight, so `x repro` can seed exactly what
// the failing code read. Sealed columns never; secret-named columns masked by core. Off, one check.

import { failureCaptureActive, recordFailureFact } from '@ultimat3/core';

/** A recorder for one entity: `sealed` is its sealed properties, which leave through no path. */
export function readRecorder(
  entity: string,
  sealed: readonly string[],
): (rows: readonly unknown[]) => void {
  return (rows) => {
    if (!failureCaptureActive()) return;
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const kept = Object.fromEntries(
        Object.entries(row).filter(([property]) => !sealed.includes(property)),
      );
      recordFailureFact({ kind: 'read', entity, row: kept });
    }
  };
}
