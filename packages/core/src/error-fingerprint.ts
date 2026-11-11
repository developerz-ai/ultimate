// Single responsibility: which error reports are the same fault. A pure function over a report,
// never a field on it: `ErrorReport` is public, and a member every hand-built report must now
// carry, or every reader must now tolerate missing, is a break for a key a monitor can derive.

import { fingerprint } from './canonical-json';
import { stringField } from './error-render';
import type { ErrorReport } from './error-reporter';
import { stackFrames } from './sentry-frames';

/** `errorReport()`'s code for a throw nobody classified: the one code too wide to group on. */
const UNCLASSIFIED = 'X_INTERNAL';

/** `@ultimat3/cli`'s one code for every browser fault: its `operation` (pattern + island) is the fault. */
const BROWSER = 'X_CLIENT_ERROR';

/** Reads that cannot throw: this runs on the path that reports a failure, and adds none. */
function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/** The top application frame as `fn path` (no line, no column), or `undefined`. */
function applicationFrame(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const frame = read(() => stackFrames(stack).find((each) => each.inApp));
  if (frame === undefined) return undefined;
  return frame.fn === undefined ? frame.path : `${frame.fn} ${frame.path}`;
}

/**
 * The monitor's group, as the envelope's `fingerprint` list: `[code]` for a classified code — one
 * code raised from five operations is one issue, its `source` and `operation` facets of it (tags,
 * `transaction`). `X_INTERNAL` adds the application frame, since on its code alone every
 * unclassified throw is one issue; `X_CLIENT_ERROR` adds its operation, since a bundle's frame
 * moves every deploy. Total: a report it cannot read degrades to `[X_INTERNAL]`.
 */
export function monitorFingerprint(report: ErrorReport): readonly string[] {
  const code = stringField(report, 'code') ?? UNCLASSIFIED;
  const extra =
    code === UNCLASSIFIED
      ? applicationFrame(stringField(report, 'stack'))
      : code === BROWSER
        ? stringField(
            read(() => report.scope),
            'operation',
          )
        : undefined;
  return extra === undefined ? [code] : [code, extra];
}

/**
 * A stable, 16-hex grouping key for a report. A coded fault groups on `code`, `source` and
 * `scope.operation`; `X_INTERNAL` adds the top application frame (function and root-relative path,
 * no line or column), because on its code alone every unclassified throw in an app is one group.
 * Never `cause`, `meta`, an id or `release`: a row id splits one fault into a group per row, and a
 * deploy is not a new fault. The LOCAL group (`errorGroupsSink`, failure capture); the monitor's is
 * `monitorFingerprint`. Total: a report it cannot read degrades to the frameless key.
 */
export function errorFingerprint(report: ErrorReport): string {
  const code = stringField(report, 'code');
  const source = stringField(report, 'source');
  const operation = stringField(
    read(() => report.scope),
    'operation',
  );
  const frame = code === UNCLASSIFIED ? applicationFrame(stringField(report, 'stack')) : undefined;
  return fingerprint({ code, source, operation, frame });
}
