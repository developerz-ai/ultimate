// Single responsibility: a repro subject read from a file a stranger may have written (`--from`, a
// bundle `create-ultimate repro` opens). Every field the replay and the written test read is
// checked and the subject REBUILT from those alone — nothing unknown rides along — and a name,
// code, step or id holding a control character (a terminal escape, a line break) is refused.

import type { FailureBundle, FailureRead } from '@ultimat3/core';
import { isJsonObject } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import type { ReproSubject } from './repro-bundle';

/** The actor a bundle carries; core's barrel names the bundle, not its parts. */
type FailureActor = NonNullable<FailureBundle['actor']>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A string a terminal or a `//` comment can print as it stands. */
const label = (value: unknown): value is string =>
  typeof value === 'string' && !CONTROL.test(value);
const labelOrNull = (value: unknown): value is string | null => value === null || label(value);
const labels = (value: unknown): value is string[] => Array.isArray(value) && value.every(label);

function actorOf(value: unknown): FailureActor | null | undefined {
  if (value === null) return null;
  if (!isJsonObject(value)) return undefined;
  const { kind, id, orgId, roles, scopes, permissions } = value;
  if (!label(kind) || !label(id) || !labelOrNull(orgId)) return undefined;
  if (!labels(roles) || !labels(scopes) || !labels(permissions)) return undefined;
  return { kind, id, orgId, roles, scopes, permissions };
}

function readsOf(value: unknown): FailureRead[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reads: FailureRead[] = [];
  for (const read of value) {
    if (!isJsonObject(read) || !label(read['entity']) || !isJsonObject(read['row']))
      return undefined;
    if (!labels(read['masked'])) return undefined;
    reads.push({ entity: read['entity'], row: read['row'], masked: read['masked'] });
  }
  return reads;
}

function bundleOf(value: Record<string, unknown>): FailureBundle | undefined {
  const { id, fingerprint, code, operation, primitive, name, at, requestId, traceId, build } =
    value;
  if (!label(id) || !label(fingerprint) || !label(code) || !labelOrNull(operation))
    return undefined;
  if ((primitive !== 'action' && primitive !== 'query') || !label(name)) return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (!labelOrNull(requestId) || !labelOrNull(traceId) || !labelOrNull(build)) return undefined;
  const actor = actorOf(value['actor']);
  const reads = readsOf(value['reads']);
  const { masked, flags, truncated } = value;
  if (actor === undefined || reads === undefined || !labels(masked) || !isJsonObject(flags)) {
    return undefined;
  }
  if (typeof truncated !== 'boolean') return undefined;
  const input = value['input'] ?? null;
  return {
    ...{ id, fingerprint, code, operation, primitive, name, at, requestId, traceId, build },
    ...{ input, masked, actor, flags, reads, truncated },
  };
}

function failureOf(value: Record<string, unknown>): JobFailure | undefined {
  const { jobId, name, masked, steps, code, step } = value;
  if (!label(jobId) || !label(name) || !labels(masked) || !Array.isArray(steps)) return undefined;
  if (!labelOrNull(code) || !labelOrNull(step)) return undefined;
  const kept: { name: string; output: unknown }[] = [];
  for (const entry of steps) {
    if (!isJsonObject(entry) || !label(entry['name'])) return undefined;
    kept.push({ name: entry['name'], output: entry['output'] ?? null });
  }
  return { jobId, name, input: value['input'] ?? null, masked, steps: kept, code, step };
}

/** The subject `value` is, rebuilt from its checked fields; `undefined` for anything else. */
export function parseReproSubject(value: unknown): ReproSubject | undefined {
  if (!isJsonObject(value)) return undefined;
  if ('jobId' in value) {
    const failure = failureOf(value);
    return failure === undefined ? undefined : { kind: 'job', failure };
  }
  const bundle = bundleOf(value);
  return bundle === undefined ? undefined : { kind: 'request', bundle };
}
