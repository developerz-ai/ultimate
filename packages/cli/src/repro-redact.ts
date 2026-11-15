// Single responsibility: a repro subject as it may leave the app — its input masked by the
// primitive's own `.sensitive()` schema, then by core's `captureValue` (secret-named keys, `Secret`s,
// the app's value patterns); each read row minus its entity's sealed columns, masked the same way;
// a row of an entity this app does not declare dropped, never guessed at. Pure over `ReproLookups`.

import type { FailureRead } from '@ultimat3/core';
import { captureValue, REDACTED } from '@ultimat3/core';
import type { EntityDescription } from '@ultimat3/entity';
import { maskSensitive } from '@ultimat3/schema';
import type { ReproSubject } from './repro-bundle';

/** What the app declared, asked by name: the registries in production, a table in a test. */
export interface ReproLookups {
  /** The input schema of the job, action or query `name`; `undefined` when none is registered. */
  inputSchema(kind: 'job' | 'action' | 'query', name: string): unknown;
  /** The entity `name`, its description and its sealed properties; `undefined` when undeclared. */
  entity(
    name: string,
  ): { readonly description: EntityDescription; readonly sealed: readonly string[] } | undefined;
}

export interface RedactedSubject {
  readonly subject: ReproSubject;
  /** The declarations of the entities whose rows the reproducer seeds, by name. */
  readonly entities: readonly EntityDescription[];
  /** Entities whose read rows were dropped: not declared by this app. Sorted, unique. */
  readonly dropped: readonly string[];
  /** Every masked path in the subject: input paths bare, `<entity>:<path>`, `step:<name>:<path>`. */
  readonly masked: readonly string[];
}

/** The input, masked by its schema's `.sensitive()` flags first, then by core's capture rules. */
function maskedInput(schema: unknown, input: unknown): { value: unknown; masked: string[] } {
  const flagged = schema === undefined ? input : maskSensitive(schema, input, REDACTED);
  const { value, masked } = captureValue(flagged);
  return { value, masked: [...masked] };
}

function redactJob(subject: Extract<ReproSubject, { kind: 'job' }>, lookups: ReproLookups) {
  const { failure } = subject;
  const input = maskedInput(lookups.inputSchema('job', failure.name), failure.input);
  const stepMasks: string[] = [];
  const steps = failure.steps.map((step) => {
    const { value, masked } = captureValue(step.output);
    stepMasks.push(...masked.map((path) => `step:${step.name}:${path}`));
    return { name: step.name, output: value };
  });
  const inputMasks = [...new Set([...failure.masked, ...input.masked])].sort();
  const redacted: ReproSubject = {
    kind: 'job',
    failure: { ...failure, input: input.value, masked: inputMasks, steps },
  };
  return { subject: redacted, entities: [], dropped: [], masked: [...inputMasks, ...stepMasks] };
}

function redactRequest(
  subject: Extract<ReproSubject, { kind: 'request' }>,
  lookups: ReproLookups,
): RedactedSubject {
  const { bundle } = subject;
  const input = maskedInput(lookups.inputSchema(bundle.primitive, bundle.name), bundle.input);
  const dropped = new Set<string>();
  const kept = new Map<string, EntityDescription>();
  const rowMasks: string[] = [];
  const reads: FailureRead[] = [];
  for (const read of bundle.reads) {
    const declared = lookups.entity(read.entity);
    if (declared === undefined) {
      dropped.add(read.entity);
      continue;
    }
    kept.set(read.entity, declared.description);
    const row = Object.fromEntries(
      Object.entries(read.row).filter(([property]) => !declared.sealed.includes(property)),
    );
    const { value, masked } = captureValue(row);
    const paths = [...new Set([...read.masked, ...masked])].sort();
    rowMasks.push(...paths.map((path) => `${read.entity}:${path}`));
    reads.push({ entity: read.entity, row: value as Record<string, unknown>, masked: paths });
  }
  const inputMasks = [...new Set([...bundle.masked, ...input.masked])].sort();
  const redacted: ReproSubject = {
    kind: 'request',
    bundle: {
      ...bundle,
      input: input.value,
      masked: inputMasks,
      flags: captureValue(bundle.flags).value as Record<string, unknown>,
      reads,
      truncated: bundle.truncated || dropped.size > 0,
    },
  };
  return {
    subject: redacted,
    entities: [...kept.keys()].sort().map((name) => kept.get(name) as EntityDescription),
    dropped: [...dropped].sort(),
    masked: [...inputMasks, ...[...new Set(rowMasks)].sort()],
  };
}

export function redactSubject(subject: ReproSubject, lookups: ReproLookups): RedactedSubject {
  return subject.kind === 'job' ? redactJob(subject, lookups) : redactRequest(subject, lookups);
}
