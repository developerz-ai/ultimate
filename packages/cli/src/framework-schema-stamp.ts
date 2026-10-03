// Which builds have applied the framework schema to this database: a stamp `ROLE=migrate` leaves
// in `x_jobs`' table comment, and the verdict a serving role reads from it instead of running DDL
// itself (plan 101, s1-con #5). Pure: the statements live in `framework-schema-apply.ts`.

import { UltimateError } from '@ultimat3/core';
import { FRAMEWORK_SCHEMA } from './framework-schema';

/**
 * The relation that carries the stamp. A comment, not a table: a new framework table moves every
 * app's committed schema dump (`packages/db/schema/framework/`), and a comment is in none of them.
 */
export const STAMP_RELATION = 'x_jobs';

/** The first line of a stamp — what tells it apart from a comment someone else wrote. */
const STAMP_HEADER = 'ultimate-framework-schema';

/** Enough for a rolling deploy and its rollback, small enough to stay one readable comment. */
const STAMP_KEEP = 16;

export interface StampEntry {
  readonly version: string;
  readonly schema: string;
}

/** This build's DDL, as one short hash: two builds with the same DDL are the same schema. */
export function frameworkSchemaHash(): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const entry of FRAMEWORK_SCHEMA) for (const ddl of entry.ddl) hasher.update(ddl);
  return hasher.digest('hex').slice(0, 16);
}

/** Every build a stamp records, newest first. Anything that is not a stamp records none. */
export function parseStamp(comment: string | null | undefined): readonly StampEntry[] {
  if (typeof comment !== 'string') return [];
  const [header, ...lines] = comment.split('\n');
  if (header !== STAMP_HEADER) return [];
  return lines.flatMap((line) => {
    const [version, schema] = line.trim().split(' ');
    return version !== undefined &&
      /^[0-9A-Za-z.+-]{1,64}$/.test(version) &&
      schema !== undefined &&
      /^[0-9a-f]{16}$/.test(schema)
      ? [{ version, schema }]
      : [];
  });
}

/** The stamp after `mine` applied: it first, every other build kept, the oldest dropped. */
export function nextStamp(previous: string | null | undefined, mine: StampEntry): string {
  const kept = parseStamp(previous).filter((entry) => entry.schema !== mine.schema);
  const entries = [mine, ...kept].slice(0, STAMP_KEEP);
  return [STAMP_HEADER, ...entries.map((entry) => `${entry.version} ${entry.schema}`)].join('\n');
}

const majorOf = (version: string): string => version.split('.')[0] ?? version;

export type StampVerdict =
  | { readonly applied: true; readonly skew?: StampEntry }
  | { readonly applied: false; readonly newest?: StampEntry };

/**
 * Applied when this build's hash is anywhere in the stamp: an old pod restarting mid-rollout finds
 * its own build there, behind the new one. `skew` is the newest build when its MAJOR differs from
 * this process's — a fleet straddling a breaking release, which a boot reports and never refuses.
 */
export function stampVerdict(entries: readonly StampEntry[], mine: StampEntry): StampVerdict {
  const newest = entries[0];
  if (!entries.some((entry) => entry.schema === mine.schema)) {
    return newest === undefined ? { applied: false } : { applied: false, newest };
  }
  return newest !== undefined && majorOf(newest.version) !== majorOf(mine.version)
    ? { applied: true, skew: newest }
    : { applied: true };
}

/** A serving role over a database its build's framework tables were never applied to. */
export class FrameworkSchemaUnappliedError extends UltimateError {
  constructor(input: { readonly mine: StampEntry; readonly newest: StampEntry | undefined }) {
    super({
      code: 'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      cause:
        `this build (${input.mine.version}, framework schema ${input.mine.schema}) has not been applied ` +
        `to this database — ${
          input.newest === undefined
            ? `${STAMP_RELATION} carries no stamp, so no ROLE=migrate of this release ran`
            : `the newest applied build is ${input.newest.version} (${input.newest.schema})`
        }. A serving role verifies and never runs DDL: the migrate step must run first`,
      fix: 'x db migrate',
      meta: {
        version: input.mine.version,
        schema: input.mine.schema,
        ...(input.newest === undefined ? {} : { newest: { ...input.newest } }),
      },
    });
  }
}
