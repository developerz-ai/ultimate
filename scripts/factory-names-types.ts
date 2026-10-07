// The TYPE half of `scripts/factory-names.ts`: a type a factory takes or builds is spelled after
// that factory. 25.0.0 renamed `createPgDriver` to `postgresJobDriver` and left its input called
// `PgDriverOptions`, `mcpServer()` taking a `CreateMcpServerInput` and `postgresAuthAdapter()`
// building a `BuiltinAdapter` — the retired spelling surviving one import away from the new one.
//
// THE RULES, each structural except the first. (1) `Create<Rest>` is a verb's spelling: clean only
// beside the package's own `create<Verb>` value (`CreateSessionInput` by `createSession`). (2) A
// `Pg|Postgres|Memory|InMemory` type that a `memoryX` / `postgresX` factory takes FIRST starts with
// the factory's name. (3) A class, or such a prefixed type, that a `memoryX` / `postgresX` factory
// is DECLARED to return IS the factory's name, capitalised. (4) A `Memory|InMemory|Postgres` type
// built by a value not spelled `memoryX` / `postgresX` means the VALUE is misspelt.
//
// WHAT THIS CANNOT SEE. A type no factory names: core's `PgExecutor` and realtime's pgoutput
// protocol types are spelled after Postgres's own vocabulary, not after a factory, and stay. `Pg`
// in rule (4) is excluded for the same reason: `bunPgStream()` builds a `PgStream`, a protocol word.

import type { Declaration } from './factory-names-declarations';
import type { ExportedName } from './factory-names-exports';

export interface TypeMisspelling {
  /** The exported name that is wrong — a type for rules 1-3, the value for rule 4. */
  readonly name: string;
  readonly canonical: string;
  readonly kind: 'type' | 'builder';
  readonly why: string;
}

/** One exported name and the binding its package declares behind it, when it declares one. */
export interface OwnExport {
  readonly exported: ExportedName;
  readonly local: string | undefined;
}

const IMPL = /^(?:In)?(Memory|Pg|Postgres)(?=[A-Z0-9])/;
const BUILT_IMPL = /^(?:In)?(Memory|Postgres)(?=[A-Z0-9])(.*)$/;
const FACTORY = /^(?:memory|postgres)[A-Z0-9]/;
const CREATE_TYPE = /^Create([A-Z0-9]\w*)$/;
/** The trailing word that says a type is a factory's argument, kept across the rename. */
const ROLE = /(Options|Input|Args|Config|Deps|Init)$/;

const upperFirst = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** `MemoryJobDriverOptions` starts with `MemoryJobDriver`; `MemoryJobDriverX2` does not count. */
const startsWithWord = (name: string, stem: string): boolean =>
  name === stem || (name.startsWith(stem) && /^[A-Z]/.test(name.slice(stem.length)));

interface Factory {
  readonly name: string;
  readonly declared: Declaration;
}

/** Rules 1-4 over one package: its own exports, and what its source declares. */
export function typeMisspellings(
  own: readonly OwnExport[],
  declarations: ReadonlyMap<string, Declaration>,
): readonly TypeMisspelling[] {
  const values: Factory[] = [];
  for (const one of own) {
    const declared = one.local === undefined ? undefined : declarations.get(one.local);
    if (!one.exported.type && declared?.kind === 'value' && /^[a-z]/.test(one.exported.name)) {
      values.push({ name: one.exported.name, declared });
    }
  }
  const factories = values.filter((value) => FACTORY.test(value.name));
  const verbs = values.filter((value) => /^create[A-Z0-9]/.test(value.name));
  const found = new Map<string, TypeMisspelling>();
  const add = (miss: TypeMisspelling): void => {
    if (!found.has(miss.name)) found.set(miss.name, miss);
  };
  for (const { exported, local } of own) {
    if (!exported.type || local === undefined) continue;
    const name = exported.name;
    const takenBy = factories.filter((one) => one.declared.accepts === local);
    const builtBy = factories.filter((one) => one.declared.returns === local);
    const create = CREATE_TYPE.exec(name);
    if (create !== null) {
      const rest = create[1] ?? '';
      if (verbs.some((verb) => startsWithWord(rest, upperFirst(verb.name.slice('create'.length)))))
        continue;
      const factory =
        values.find((one) => one.declared.accepts === local) ??
        values.find((one) => one.declared.returns === local);
      const role = ROLE.exec(name)?.[1] ?? '';
      add({
        name,
        kind: 'type',
        canonical: factory === undefined ? rest : `${upperFirst(factory.name)}${role}`,
        why:
          factory === undefined
            ? `Create<Thing> is a verb's spelling, and the package exports no create<Verb> it belongs to`
            : `Create<Thing> is a verb's spelling, and what takes it is ${factory.name}(), so it is spelled after ${factory.name}`,
      });
      continue;
    }
    if (IMPL.test(name) && takenBy.length > 0) {
      if (!takenBy.some((one) => startsWithWord(name, upperFirst(one.name)))) {
        const factory = takenBy[0] as Factory;
        add({
          name,
          kind: 'type',
          canonical: `${upperFirst(factory.name)}${ROLE.exec(name)?.[1] ?? 'Options'}`,
          why: `it is what ${factory.name}() takes, so it is spelled after ${factory.name}`,
        });
      }
      continue;
    }
    const isClass = declarations.get(local)?.kind === 'class';
    if ((isClass || IMPL.test(name)) && builtBy.length > 0) {
      if (!builtBy.some((one) => name === upperFirst(one.name))) {
        const factory = builtBy[0] as Factory;
        add({
          name,
          kind: 'type',
          canonical: upperFirst(factory.name),
          why: `it is what ${factory.name}() builds, so it is named ${upperFirst(factory.name)}`,
        });
      }
      continue;
    }
    const impl = BUILT_IMPL.exec(name);
    if (impl === null) continue;
    for (const builder of values.filter((one) => one.declared.returns === local)) {
      if (FACTORY.test(builder.name)) continue;
      const prefix = impl[1] === 'Memory' ? 'memory' : 'postgres';
      add({
        name: builder.name,
        kind: 'builder',
        canonical: `${prefix}${upperFirst(builder.name)}`,
        why: `it builds ${name}, so it is a ${prefix}X factory`,
      });
    }
  }
  return [...found.values()];
}
