// Single responsibility: say, after a successful action input parse, which keys the parse dropped
// because the input schema never declared them (#1281). The answer is unchanged — refusing is a
// break and waits for `next` — so in 31.x this is a coded `log.record` warning plus a span event.
// `@ultimat3/query`'s `validate-unknown-keys.ts` is the read twin (query cannot import action).

import {
  currentSpan,
  logger,
  nearestName,
  renderCauseValue,
  renderFixShellArg,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { tryIntrospect, unknownKeys } from '@ultimat3/schema';

/** The log message and span-event name: a subscriber matches `log.record`'s `message` on it. */
export const INPUT_UNKNOWN_KEY = 'input.unknown_key';

/**
 * The warning's code, on `fields.code`. A refusal under the same code is `next`'s, not 31.x's.
 * Titled in `@ultimat3/query`'s server-only `errors.ts`: this package's titles ride in `rpc`.
 */
const CODE = 'X_INPUT_UNKNOWN_KEY';

/** Reports already logged. Bounded: the keys are the caller's, and a flood must not grow a set. */
const MAX_REPORTS = 1_000;
const reported = new Set<string>();

/** A path is the caller's text: bounded before it reaches a log line or a span. */
const MAX_PATH = 128;
const bounded = (path: string): string =>
  path.length <= MAX_PATH ? path : `${path.slice(0, MAX_PATH)}…`;

/**
 * Called by `parseActionInput` with the RAW input, after it parsed. Silent for a clean input and a
 * schema the active provider cannot describe. The span event fires on every call (the dev
 * timeline's request); the log line once per action and set of paths, so a client in the field
 * sending one stale key every request is one line, not a line per request.
 */
export function reportUnknownInputKeys(
  schema: StandardSchemaV1,
  raw: unknown,
  actionName: string,
): void {
  const node = tryIntrospect(schema);
  if (node === undefined) return;
  const found = unknownKeys(node, raw);
  if (found.length === 0) return;
  const keys = found.map(({ path, key, declared }) => {
    const nearest = nearestName(key, declared);
    return nearest === undefined ? { path: bounded(path) } : { path: bounded(path), nearest };
  });
  const paths = keys.map((entry) => entry.path);
  currentSpan()?.addEvent(INPUT_UNKNOWN_KEY, { code: CODE, action: actionName, keys: paths });
  const report = JSON.stringify([actionName, paths]);
  if (reported.has(report) || reported.size >= MAX_REPORTS) return;
  reported.add(report);
  const first = keys[0];
  const rename =
    first?.nearest === undefined
      ? 'declare the field in the input schema, or stop sending it'
      : `rename ${renderCauseValue(first.path)} to "${first.nearest}" in the caller, or declare it in the input schema`;
  logger.warn(INPUT_UNKNOWN_KEY, {
    code: CODE,
    action: actionName,
    keys,
    cause: `input for action "${actionName}" carried ${paths.map(renderCauseValue).join(', ')}, which its input schema does not declare; the parse dropped ${paths.length === 1 ? 'it' : 'them'} and the call ran without`,
    fix: `x actions show ${renderFixShellArg(actionName, '<action-name>')} --json   # the declared input — ${rename}`,
  });
}

/** TEST SEAM: forget every logged report. */
export function resetUnknownKeyReports(): void {
  reported.clear();
}
