// The rows `scripts/factory-names.ts` does not report, each with its sentence. Data only: the
// guard reads it, and a row that silences no finding is itself a finding, so the table only shrinks.
//
// TWO tables, two meanings. `exceptions`: the rule is wrong about this name, and the sentence says
// why — it never becomes a rename. `owed`: the rule is right and the rename belongs to a package
// whose owner has not made it yet; the sentence names the rename. Keys are the finding's own:
// `<package> <export>` for a spelling, `<package> + <package> <name>` for a collision.

export interface FactoryNamePins {
  readonly exceptions: Readonly<Record<string, string>>;
  readonly owed: Readonly<Record<string, string>>;
}

export const NO_PINS: FactoryNamePins = { exceptions: {}, owed: {} };

export const FACTORY_NAME_PINS: FactoryNamePins = {
  exceptions: {
    // why: a deliberate exception, its reason the row's own sentence — a verb that does I/O, not a factory
    '@ultimat3/db createBranch':
      'a verb, not a factory: it runs CREATE DATABASE … TEMPLATE beside dropBranch, listBranches and reapBranches, and the value it answers is a report of that act',
    // why: a deliberate exception, its reason the row's own sentence — a verb that does I/O, not a factory
    '@ultimat3/auth createSession':
      'a verb, not a factory: it writes the session row and answers the token, beside rotateSession and revokeSession',
    // why: a deliberate exception, its reason the row's own sentence — the verb is the product's name
    'create-ultimate createApp':
      "the package IS `bun create ultimate`: createApp scaffolds an app on disk and answers an exit code — the verb is the product's name",
    // why: a deliberate exception, its reason the row's own sentence — a rename would only move the cost
    '@ultimat3/i18n + @ultimat3/schema t':
      "two vocabularies that live in different files by construction — schema's t in the action, entity, query and job declarations, i18n's t('key') in pages and components: measured 2026-10-07, 59 files import i18n's t and 308 import schema's (directly or through a re-exporting package), and not one imports both, so no file aliases either and a rename would touch hundreds of files to separate two that never meet",
  },
  // Measured 2026-10-06, when the rule widened from the memory / Postgres prefixes to every
  // create<Thing>, every class beside its factory and every name two packages declare: each row a
  // rename that package's owner makes — never a new row for a new export.
  owed: {},
};
