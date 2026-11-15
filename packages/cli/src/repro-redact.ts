// Single responsibility: a repro subject as it may leave the app. Always: input masked by its
// `.sensitive()` schema and core's `captureValue`, rows minus sealed columns, undeclared entities
// dropped. By default, every value that is not a key becomes a stand-in the replay fills
// (`@ultimat3/testing`'s `repro-stand-in.ts`) and the actor's org a placeholder; `includeRows` opts out.

import type { FailureBundle, FailureRead } from '@ultimat3/core';
import { captureValue, REDACTED } from '@ultimat3/core';
import type { EntityDescription } from '@ultimat3/entity';
import { maskSensitive } from '@ultimat3/schema';
import type { ReproSubject } from './repro-bundle';

/** The actor a bundle carries; core's barrel names the bundle, not its parts. */
type FailureActor = NonNullable<FailureBundle['actor']>;

/** What the app declared, asked by name: the registries in production, a table in a test. */
export interface ReproLookups {
  /** The input schema of the job, action or query `name`; `undefined` when none is registered. */
  inputSchema(kind: 'job' | 'action' | 'query', name: string): unknown;
  /** The entity `name`, its description and its sealed properties; `undefined` when undeclared. */
  entity(
    name: string,
  ): { readonly description: EntityDescription; readonly sealed: readonly string[] } | undefined;
}

export interface RedactOptions {
  /** `x repro --bundle --include-rows`: real non-key values. Secrets stay masked either way. */
  readonly includeRows: boolean;
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

/** The actor's org, everywhere it appears: a uuid so a uuid column still takes it. */
export const ORG_STAND_IN = '00000000-0000-4000-8000-000000000001';

/** A key by its name: `id`, `postId`, `post_id`, `tagIds`. What seeding links rows by. */
const KEY_NAME = /^id$|Ids?$|_ids?$/;

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort();

/**
 * Every leaf not under a key name, replaced — `REDACTED` (which the replay fills from the schema)
 * or, where `typed` asks for a shape the replay cannot rebuild, `0` for a number and the boolean as
 * it was. Each replaced path is listed.
 */
function standIn(value: unknown, at: string, masked: string[], typed: boolean, key = ''): unknown {
  if (value === REDACTED || value === null || value === undefined) return value;
  if (Array.isArray(value))
    return value.map((entry) => standIn(entry, `${at}[]`, masked, typed, key));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value)) {
      const path = at === '' ? name : `${at}.${name}`;
      Object.defineProperty(out, name, {
        value: standIn(entry, path, masked, typed, name),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (KEY_NAME.test(key)) return value;
  if (typed && typeof value === 'boolean') return value;
  masked.push(at);
  return typed && typeof value === 'number' ? 0 : REDACTED;
}

/** The input, masked by its schema's `.sensitive()` flags, core's capture rules, then stood in. */
function maskedInput(schema: unknown, input: unknown, options: RedactOptions) {
  const flagged = schema === undefined ? input : maskSensitive(schema, input, REDACTED);
  const { value, masked } = captureValue(flagged);
  const paths = [...masked];
  const kept = options.includeRows ? value : standIn(value, '', paths, false);
  return { value: kept, masked: paths };
}

/** Every string leaf equal to the actor's org, replaced by `ORG_STAND_IN`. */
function withOrg(value: unknown, org: string): unknown {
  if (value === org) return ORG_STAND_IN;
  if (Array.isArray(value)) return value.map((entry) => withOrg(entry, org));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    Object.defineProperty(out, name, {
      value: withOrg(entry, org),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function redactJob(
  subject: Extract<ReproSubject, { kind: 'job' }>,
  lookups: ReproLookups,
  options: RedactOptions,
): RedactedSubject {
  const { failure } = subject;
  const input = maskedInput(lookups.inputSchema('job', failure.name), failure.input, options);
  const stepMasks: string[] = [];
  const steps = failure.steps.map((step) => {
    const { value, masked } = captureValue(step.output);
    const paths = [...masked];
    const output = options.includeRows ? value : standIn(value, '', paths, true);
    stepMasks.push(...sorted(paths).map((path) => `step:${step.name}:${path}`));
    return { name: step.name, output };
  });
  const inputMasks = sorted([...failure.masked, ...input.masked]);
  return {
    subject: {
      kind: 'job',
      failure: { ...failure, input: input.value, masked: inputMasks, steps },
    },
    entities: [],
    dropped: [],
    masked: [...inputMasks, ...stepMasks],
  };
}

/** The properties a row keeps under stand-ins: its primary key, its references, and key names. */
const keysOf = (description: EntityDescription): ReadonlySet<string> =>
  new Set(
    description.columns
      .filter((column) => column.primaryKey || column.references !== null)
      .map((column) => column.property),
  );

function redactRead(
  read: FailureRead,
  declared: { readonly description: EntityDescription; readonly sealed: readonly string[] },
  options: RedactOptions,
): FailureRead {
  const keys = keysOf(declared.description);
  const row = Object.fromEntries(
    Object.entries(read.row).filter(([property]) => !declared.sealed.includes(property)),
  );
  const { value, masked } = captureValue(row);
  const paths = [...read.masked, ...masked];
  const kept = value as Record<string, unknown>;
  if (!options.includeRows) {
    for (const [property, entry] of Object.entries(kept)) {
      if (keys.has(property) || KEY_NAME.test(property) || entry === null || entry === REDACTED)
        continue;
      kept[property] = REDACTED;
      paths.push(property);
    }
  }
  return { entity: read.entity, row: kept, masked: sorted(paths) };
}

function redactRequest(
  subject: Extract<ReproSubject, { kind: 'request' }>,
  lookups: ReproLookups,
  options: RedactOptions,
): RedactedSubject {
  const { bundle } = subject;
  const input = maskedInput(
    lookups.inputSchema(bundle.primitive, bundle.name),
    bundle.input,
    options,
  );
  const dropped = new Set<string>();
  const kept = new Map<string, EntityDescription>();
  const reads: FailureRead[] = [];
  for (const read of bundle.reads) {
    const declared = lookups.entity(read.entity);
    if (declared === undefined) {
      dropped.add(read.entity);
      continue;
    }
    kept.set(read.entity, declared.description);
    reads.push(redactRead(read, declared, options));
  }
  const inputMasks = sorted([...bundle.masked, ...input.masked]);
  const org = options.includeRows ? null : (bundle.actor?.orgId ?? null);
  const swap = <T>(value: T): T => (org === null ? value : (withOrg(value, org) as T));
  const actor: FailureActor | null =
    bundle.actor === null || org === null ? bundle.actor : { ...bundle.actor, orgId: ORG_STAND_IN };
  return {
    subject: {
      kind: 'request',
      bundle: {
        ...bundle,
        input: swap(input.value),
        masked: inputMasks,
        actor,
        flags: captureValue(bundle.flags).value as Record<string, unknown>,
        reads: swap(reads),
        truncated: bundle.truncated || dropped.size > 0,
      },
    },
    entities: [...kept.keys()].sort().map((name) => kept.get(name) as EntityDescription),
    dropped: [...dropped].sort(),
    masked: [
      ...inputMasks,
      ...sorted(reads.flatMap((read) => read.masked.map((path) => `${read.entity}:${path}`))),
    ],
  };
}

export function redactSubject(
  subject: ReproSubject,
  lookups: ReproLookups,
  options: RedactOptions,
): RedactedSubject {
  return subject.kind === 'job'
    ? redactJob(subject, lookups, options)
    : redactRequest(subject, lookups, options);
}
