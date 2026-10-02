// Single responsibility: the SHAPE of a whole schema as the catalog holds it — every object kind
// the schema dump renders, in Postgres' own spelling. Distinct from `SchemaDescription`
// (`introspect.ts`) on purpose: that one is the entity vocabulary a snapshot is diffed in, and a
// catalog spelling can never compare equal to a generated one. This one is only ever compared to
// itself, which is why it may carry `pg_get_*def` text verbatim.

export interface CatalogExtension {
  readonly name: string;
}

export interface CatalogEnum {
  readonly kind: 'enum';
  readonly name: string;
  /** In `enumsortorder` — the order `create type … as enum` must repeat. */
  readonly labels: readonly string[];
}

export interface CatalogConstraint {
  readonly name: string;
  /** `pg_get_constraintdef` verbatim: `CHECK ((x > 0))`, `PRIMARY KEY (id)`, `FOREIGN KEY …`. */
  readonly definition: string;
}

export interface CatalogDomain {
  readonly kind: 'domain';
  readonly name: string;
  readonly baseType: string;
  readonly notNull: boolean;
  readonly default: string | null;
  readonly checks: readonly CatalogConstraint[];
}

export type CatalogType = CatalogEnum | CatalogDomain;

/** Every option spelled, defaults included: a clause left out is a clause two servers may default apart. */
export interface CatalogSequence {
  readonly name: string;
  readonly dataType: string;
  readonly start: string;
  readonly increment: string;
  readonly min: string;
  readonly max: string;
  readonly cache: string;
  readonly cycle: boolean;
}

/** A sequence a `serial` column owns: created before its table, tied to the column after. */
export interface CatalogOwnedSequence extends CatalogSequence {
  readonly column: string;
}

export interface CatalogColumn {
  readonly name: string;
  /** `format_type` — `character varying(120)`, `numeric(12,2)`, `timestamp with time zone`. */
  readonly type: string;
  readonly notNull: boolean;
  /** `pg_get_expr` of the default; `null` when there is none or the column is generated. */
  readonly default: string | null;
  /** The stored generation expression, when `attgenerated` says the column has one. */
  readonly generated: string | null;
  /** `always` / `by default`, with the identity sequence's own options. */
  readonly identity: {
    readonly mode: 'always' | 'by default';
    readonly sequence: CatalogSequence;
  } | null;
  /** Only when it differs from the type's own collation. */
  readonly collation: string | null;
}

export type CatalogReplicaIdentity =
  | { readonly kind: 'default' | 'full' | 'nothing' }
  | { readonly kind: 'index'; readonly index: string };

export interface CatalogTable {
  readonly name: string;
  readonly unlogged: boolean;
  /** `reloptions` joined — `fillfactor=70` — or `null`. */
  readonly options: string | null;
  /** In `attnum` order. */
  readonly columns: readonly CatalogColumn[];
  /** Primary key, unique, check and exclusion constraints — never a foreign key. */
  readonly constraints: readonly CatalogConstraint[];
  readonly sequences: readonly CatalogOwnedSequence[];
  readonly replicaIdentity: CatalogReplicaIdentity;
}

/** An index no constraint backs; a constraint's own index is created by the constraint. */
export interface CatalogIndex {
  /** The relation it is on — a table, or a materialized view. */
  readonly table: string;
  readonly name: string;
  /** `pg_get_indexdef` verbatim. */
  readonly definition: string;
}

export interface CatalogForeignKey extends CatalogConstraint {
  readonly table: string;
}

export interface CatalogView {
  readonly name: string;
  readonly materialized: boolean;
  readonly options: string | null;
  /** `pg_get_viewdef` verbatim, trailing `;` and all. */
  readonly definition: string;
}

export interface CatalogFunction {
  readonly name: string;
  /** `pg_get_function_identity_arguments` — what tells two overloads apart. */
  readonly arguments: string;
  /** `pg_get_functiondef` verbatim. */
  readonly definition: string;
}

export interface CatalogTrigger {
  readonly table: string;
  readonly name: string;
  /** `pg_get_triggerdef` verbatim. */
  readonly definition: string;
  /** `tgenabled`: `O` origin (the default), `D` disabled, `R` replica, `A` always. */
  readonly enabled: string;
}

/**
 * An object in the schema that the dump has no statement for. Named rather than dropped: a dump
 * that silently omitted a row-security policy would load into a database that is not the one the
 * migrations build, and the load-equals-replay check could not see it, because both sides of that
 * comparison would be blind in the same place.
 */
export interface CatalogUnrendered {
  readonly kind: string;
  readonly name: string;
  /** The table it hangs off, when it has one. */
  readonly table: string | null;
}

export interface CatalogDescription {
  readonly schema: string;
  readonly extensions: readonly CatalogExtension[];
  readonly types: readonly CatalogType[];
  /** Sequences no column owns. */
  readonly sequences: readonly CatalogSequence[];
  readonly tables: readonly CatalogTable[];
  readonly indexes: readonly CatalogIndex[];
  readonly foreignKeys: readonly CatalogForeignKey[];
  readonly views: readonly CatalogView[];
  readonly functions: readonly CatalogFunction[];
  readonly triggers: readonly CatalogTrigger[];
  readonly unrendered: readonly CatalogUnrendered[];
}

/** Every list empty — the base a test or a caller spreads its one interesting object over. */
export const emptyCatalog = (schema = 'public'): CatalogDescription => ({
  schema,
  extensions: [],
  types: [],
  sequences: [],
  tables: [],
  indexes: [],
  foreignKeys: [],
  views: [],
  functions: [],
  triggers: [],
  unrendered: [],
});
