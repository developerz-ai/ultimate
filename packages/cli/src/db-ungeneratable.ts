// The hand-written-SQL rail at the gate: a committed `up` holding statements `x db gen` could
// never have written must say how many, or a squash discards them in silence. Files, not the
// database, so the rail fires in CI. `@ultimat3/db` owns the classifier (`GENERATABLE_FORMS`);
// this file owns the declaration an app makes about its own migration, and the code for it.

import { UltimateError } from '@ultimat3/core';
import { ungeneratableStatements } from '@ultimat3/db';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import { type Finding, findingFrom } from './output';

/** The header line a migration carries to declare how many hand-written statements it holds. */
export const ungeneratableMarker = (count: number): string => `-- ungeneratable: ${count}`;

/**
 * Everything before the first statement: whitespace and comments, and nothing else can be there.
 *
 * That restriction is the whole reason the marker is a HEADER line rather than any top-level
 * comment. `hasDestructiveMarker` had to be rewritten as a lexical scan because a regex over the
 * raw file matched its marker inside a block comment and inside a dollar-quoted body, where it
 * declares nothing — and `noiseAt`, the scanner that answers that, is `@ultimat3/db`'s and is not
 * exported. A run anchored at index 0 needs no scanner to be exact: before the first statement
 * there is no string, no quoted identifier and no dollar body for a marker to hide in.
 *
 * A nested block comment (`/* /* *\/ *\/`, which Postgres allows) ends the run early, so a marker
 * below one is not seen and the migration reports. Fail-closed, which is the safe direction: the
 * repair is moving the line up, never a finding nobody can see.
 */
const HEADER = /^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))*/;

/** Anchored to the whole line, so `-- ungeneratable: 2 was wrong` declares nothing. */
const MARKER_LINE = /^[ \t]*--[ \t]*ungeneratable:[ \t]*(\d+)[ \t]*\r?$/im;

/**
 * How many hand-written statements this `up` admits to. Absent is `0` — a migration that says
 * nothing has declared nothing, which is what makes the rule apply to every app that never heard
 * of it.
 *
 * The FIRST marker wins where a file carries two. Taking the largest would let a stale line raise
 * the allowance of the file it sits in, and the direction that fires is `found > declared`.
 */
export function declaredUngeneratable(up: string): number {
  const header = HEADER.exec(up)?.[0] ?? '';
  // Block comments come out first: everything left in the run is then whitespace or a line
  // comment, and a marker inside `/* … */` is prose about a marker rather than one.
  const lines = header.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const declared = MARKER_LINE.exec(lines)?.[1];
  return declared === undefined ? 0 : Number.parseInt(declared, 10);
}

/**
 * A migration holding SQL no declaration carries and no snapshot records.
 *
 * One error per file, never one per statement: the header line declares the whole migration, so a
 * second finding would repeat the instruction the first already gave — `migrationDestructive`'s
 * rule, for the same reason.
 *
 * Two remedies, and the order is deliberate. The marker is always available and always correct:
 * the statement stays, and the next author to squash these migrations is told by the file itself
 * that regenerating it loses something. Re-declaring is available only for the statements an
 * entity can express — an enum is a text column plus a check invariant, which `x db gen` writes —
 * and never for `REPLICA IDENTITY FULL`, which nothing in the framework emits, so a `fix:` naming
 * only the second branch would be an instruction half its readers cannot carry out.
 */
export class MigrationUngeneratableError extends UltimateError {
  constructor(input: { file: string; declared: number; statements: readonly string[] }) {
    const found = input.statements.length;
    // The count is stated once. `migrationDestructive` says "(and 3 more)" because its subject is
    // one statement plus an unstated remainder; here the number IS the declaration being asked for,
    // so repeating it as a remainder would print the same fact twice in one line.
    const first = `${found === 1 ? '' : `, the first of ${found}`}: ${input.statements[0] ?? ''}`;
    super({
      code: 'X_MIGRATION_UNGENERATABLE',
      cause:
        `${input.file} holds ${found} statement${found === 1 ? '' : 's'} x db gen could not have ` +
        `written and declares ${input.declared}${first}`,
      fix:
        `add the header line "${ungeneratableMarker(found)}" to ${input.file}, so a squash carries ` +
        'these statements by hand — or re-declare what an entity can express (an enum is a text ' +
        'column plus a check invariant) and regenerate: x db gen "<name>"',
    });
  }
}

/**
 * Every committed migration whose `up` holds more hand-written statements than its header admits.
 *
 * `readMigrations` is the reader `x db migrate` applies from, and only its `up` half is judged —
 * a rail checking a list the migrator does not run, or SQL the migrator never sends, enforces
 * nothing. An app with no migrations directory has nothing to declare and reports nothing.
 *
 * A declared count HIGHER than what is there is not a finding: the ratchet only refuses a rise,
 * exactly as `README_FENCE_BACKLOG` and `TEST_TYPECHECK_PINS` do, and a count that fell is a pin
 * nobody lowered rather than SQL nobody can see.
 */
export async function checkUngeneratableMigrations(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const migration of await readMigrations(root)) {
    const statements = ungeneratableStatements(migration.up);
    const declared = declaredUngeneratable(migration.up);
    if (statements.length <= declared) continue;
    const file = `${MIGRATIONS_DIR}/${migration.id}.sql`;
    findings.push({
      ...findingFrom(new MigrationUngeneratableError({ file, declared, statements })),
      at: file,
    });
  }
  return findings;
}
