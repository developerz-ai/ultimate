// Single responsibility: the drift a hash cannot see — what the app's entities declare NOW against
// the schema the newest migration wrote down. No database, so the gate runs it in a CI with nothing
// listening, exactly as the source-hash half does.
//
// It exists because the hash half compares a schema-source hash to a `.hash` sidecar and never
// reads what the migration RECORDED: `dummy/social-media-clone` sat green on `drift` while nine
// declared CHECK constraints had never reached any database, and a squash produced a migration
// missing ten invariants and nine defaults with the gate green over it. Nothing that hashes source
// can see either, because the source did not move.

// why: Bun exposes no synchronous "does this path exist" primitive, and this is a probe rather
// than a read — `Bun.file().exists()` answers about a file where the question is about a directory.
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner of its own, and this path is built to be probed, never opened.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { EntityDescriptionLike, UnrenderedDeclaration } from '@ultimat3/db';
import { declaredSchema, snapshotOf, unrenderedOf } from '@ultimat3/db';
import { describeEntities } from '@ultimat3/entity';
import { loadApp } from './app-load';
import { checkSourceDrift, DB_PACKAGE } from './drift';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { Finding } from './output';
import { diffDeclaredSchema, type SchemaDifference } from './schema-diff';

/**
 * What the app declares, or `undefined` when the app would not load. Injected so this module's
 * rules are testable against hand-built descriptions with no app on disk, and so the ONE thing a
 * caller must never do — read a short registry as the whole schema — has a single seam.
 */
export type DeclaredEntities = (
  root: string,
) => Promise<readonly EntityDescriptionLike[] | undefined>;

/**
 * `undefined`, never a short list. A module that will not import leaves the registry missing the
 * entities it would have registered, and a short registry against a whole snapshot reads as "every
 * one of these tables was dropped" — a DROP per table, handed out as the fix, for a syntax error in
 * one file. `loadApp`'s findings are reported by the steps that own them.
 */
const appEntities: DeclaredEntities = async (root) => {
  const app = await loadApp(root);
  if (app.findings.length > 0) return undefined;
  return describeEntities();
};

/**
 * `x db gen` is the repair for both directions — and it is the WRONG instruction while the
 * declaration holds something this generator cannot write down, because regenerating drops it
 * silently and the result is green. In that state the unrendered entry's own `fix:` is the
 * instruction: `@ultimat3/db` owns that wording, and a second one here would drift from it.
 */
function repairFix(
  unrendered: readonly UnrenderedDeclaration[],
  difference: SchemaDifference,
): string {
  // The entry ABOUT this difference first, then any entry at all. Reading `unrendered[0]`
  // unconditionally meant that in any app carrying an unrendered DEFAULT, every difference —
  // a dropped CHECK included — was answered with the default's edit, which is an instruction for
  // a different problem in a different file.
  const named = unrendered.find(
    (entry) => entry.table === difference.table && entry.name === difference.name,
  );
  // The entry ABOUT this difference carries the edit that repairs it, so it is the whole answer.
  if (named !== undefined) return named.fix;
  // Otherwise `x db gen` is still unsafe — it would drop what the other entries name — but the
  // reader must NOT be handed a different declaration's edit as the instruction for this one.
  // Reading `unrendered[0]` did exactly that: a column default and an index each got
  // `invariant('org_slug_shape', …)`, an edit in another file about another rule.
  // No `x db gen` in this branch, and that is the point: while ANY declaration reaches no SQL,
  // regenerating drops it, so the command is the wrong instruction for every difference in the
  // app — not only for the one the entry names.
  const blocker = unrendered[0];
  if (blocker !== undefined) {
    return `${blocker.fix}   # ${blocker.table}.${blocker.name} reaches no SQL, so regenerating would drop it; repair that before recording ${difference.name}`;
  }
  // "record", not "add": one finding covers a declaration the migrations never carried AND one they
  // carry differently, so `add` would be a wrong migration name for half of them. `undeclared` gets
  // both branches, in the order they are safe — regenerating emits the DROP, and the declaration
  // may have been LOST rather than removed, which is the whole reason this direction is its own
  // finding.
  return difference.direction === 'unmigrated'
    ? `x db gen "record ${difference.name}"`
    : `x db gen "drop ${difference.name}"   # or re-declare ${difference.name} on the entity`;
}

/**
 * Two directions, two codes, because they are two repairs. `unmigrated` means the database will
 * never get what the app declares; `undeclared` means the database holds what nothing declares.
 * One "drift" verdict over both teaches a reader neither.
 */
function findingFor(difference: SchemaDifference, fix: string): Finding {
  const cause = `${difference.part} "${difference.name}" on table "${difference.table}" ${difference.detail}`;
  return difference.direction === 'unmigrated'
    ? { code: 'X_DB_SCHEMA_UNMIGRATED', cause, fix, docs: ERROR_DOCS_URL, at: MIGRATIONS_DIR }
    : { code: 'X_DB_SCHEMA_UNDECLARED', cause, fix, docs: ERROR_DOCS_URL, at: MIGRATIONS_DIR };
}

/**
 * One finding per difference, never one per table: each names one declaration and one edit, and a
 * grouped finding would hand a reader nine constraint names under one instruction.
 *
 * Three conditions are deliberately left to their own reporters, because each already has a code
 * and a remedy: an app with no `packages/db`, an app whose first migration has not been generated
 * (`checkSourceDrift`, `x db gen "initial"`), and a newest migration carrying no sidecar
 * (`X_MIGRATION_SNAPSHOT_MISSING`, whose two-branch fix is `@ultimat3/db`'s).
 */
export async function checkSnapshotDrift(
  root: string,
  declared: DeclaredEntities = appEntities,
): Promise<readonly Finding[]> {
  if (!existsSync(join(root, DB_PACKAGE))) return [];
  const entities = await declared(root);
  if (entities === undefined) return [];
  const migrations = await readMigrations(root);
  if (migrations.length === 0) return [];
  const recorded = declaredSchema(migrations);
  if (recorded === undefined) return [];
  const differences = diffDeclaredSchema(snapshotOf(entities), recorded);
  if (differences.length === 0) return [];
  // `recorded` and not the entities alone: whether an `assert` is a LOSS depends on whether a
  // migration recorded a CHECK for it, which only the sidecar knows.
  const unrendered = unrenderedOf(entities, recorded);
  return differences.map((difference) => findingFor(difference, repairFix(unrendered, difference)));
}

/**
 * The whole no-database drift answer, for the gate step and for `x doctor` — one composition, so
 * the two can never disagree about an app.
 *
 * The source hash STAYS, and it runs second. It catches a class this comparison cannot see at all:
 * a seed, a repo helper or a TS-only invariant moving under `packages/db/src` with no physical
 * schema behind it, which is what `reconcileSchemaHash` exists to re-record. It is suppressed when
 * the snapshot half found something, because both then answer one condition and only one of them
 * is an instruction — `schema hashes to 3f2a, newest migration recorded 91bc` names no constraint,
 * no column and no table.
 */
export async function checkMigrationDrift(
  root: string,
  declared: DeclaredEntities = appEntities,
  hashDrift: (root: string) => Promise<readonly Finding[]> = checkSourceDrift,
): Promise<readonly Finding[]> {
  const snapshot = await checkSnapshotDrift(root, declared);
  if (snapshot.length > 0) return snapshot;
  return hashDrift(root);
}
