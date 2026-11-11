// The plan `seedGraph` returns and the one way it is written: every insert in order, then every
// key a cycle deferred. Data only, so a caller can diff two plans, print one, or hand it to a
// writer over any driver — the graph itself never touches a database.

/** A factory the app wrote, structurally: what it builds wins over anything generated. */
export interface SeedFactory {
  build(): object;
  reset(): void;
  /**
   * Columns that follow from what the GRAPH chose — its keys and references, which no factory
   * builds: `memorial_templates.scopeKey` from `ownerOrgId`. Called on each candidate row before
   * its rules are judged; what it answers wins. A `defineFactory` with it:
   * `{ build: () => f.build(), reset: () => f.reset(), derive: (row) => ({ … }) }`.
   */
  derive?(row: Readonly<Record<string, unknown>>): object;
}

export interface SeedGraphOptions {
  /** Tenants to seed, each with its own copy of every tenant-scoped table. Default 2. */
  readonly tenants?: number;
  /** Rows per table, per tenant for a tenant-scoped one. Default 3. */
  readonly perTable?: number;
  readonly seed?: number;
  /** By entity name. A column the factory builds takes its value; keys stay the graph's. */
  readonly factories?: Readonly<Record<string, SeedFactory>>;
  /**
   * A graph already written to the same database. Each table's row positions — the ordinal a
   * generated value is built from, a factory's `index` — continue past its `next`, so a value built
   * from a position (`code: \`c${index}\``) never repeats one of its rows on a unique column.
   */
  readonly beside?: SeedGraph;
  /**
   * The instant the database's partitions were made around — the migration's apply time. A
   * `partitionBy` column's values land in the bucket holding it, which the migration always makes.
   * Default `systemClock.now()`: in a test under a frozen clock, pass the database's `now()`.
   */
  readonly now?: Date | undefined;
}

export interface SeedRow {
  readonly entity: string;
  readonly table: string;
  /**
   * The tenant instance the row belongs to: its tenant column's, the root row's own, or — for a
   * child with no tenant column and no `shared` reason — the tenant of the parent it hangs off.
   * `null` only for a row of no tenant. The tenant proof's per-instance id list is this field.
   */
  readonly tenant: string | null;
  /** As INSERTED: a key deferred to break a cycle is null here and set by an update. */
  readonly row: Readonly<Record<string, unknown>>;
}

export interface SeedUpdate {
  readonly entity: string;
  readonly tenant: string | null;
  /** The row's primary key, by property. */
  readonly key: Readonly<Record<string, unknown>>;
  readonly patch: Readonly<Record<string, unknown>>;
}

/**
 * One per row: the marker its text columns carry, so a later read can say whose row it saw. One
 * marker per ROW, every text column carrying it: a find names the path, the row is the marker's.
 * A column whose format cannot hold it (uuid, enum, a short char) is absent from `columns`.
 */
export interface SeedCanary {
  readonly entity: string;
  readonly tenant: string | null;
  readonly key: Readonly<Record<string, unknown>>;
  readonly marker: string;
  readonly columns: readonly string[];
}

export interface SeedGraph {
  readonly seed: number;
  readonly tenants: readonly string[];
  readonly order: readonly string[];
  readonly inserts: readonly SeedRow[];
  readonly updates: readonly SeedUpdate[];
  /** One per insert, in the same order: `canaries[i]` is `inserts[i]`'s. */
  readonly canaries: readonly SeedCanary[];
  /**
   * Per table, the row position a graph written `beside` this one starts at: its own `beside`'s
   * plus every row this graph built. Absent on a hand-written graph: positions then start at 0.
   */
  readonly next?: Readonly<Record<string, number>>;
}

/** Where `insertSeedGraph` writes. One insert per row, in order, then one update per deferred key. */
export interface SeedWriter {
  insert(row: SeedRow): Promise<void>;
  /**
   * Rows of ONE entity, in plan order, as one write — `insertAll`. Optional: a writer without it
   * takes `insert` per row. With it, a graph costs one statement per table, not one per row: a
   * pass seeding a fresh tenant pair per primitive writes primitives × tables rows.
   */
  insertMany?(rows: readonly SeedRow[]): Promise<void>;
  update(update: SeedUpdate): Promise<void>;
  /**
   * Each row read back by its primary key, as one digest per row in the order given — `null` for
   * a row no longer there. Equal digests mean an unchanged row; the tenant proof's write half
   * compares two snapshots. Soft-deleted rows are read too, so a soft delete is a change.
   */
  snapshot(rows: readonly SeedRow[]): Promise<readonly (string | null)[]>;
}

/**
 * Each run of consecutive rows of one entity. The plan writes table by table, so a run is a table's
 * rows — and a parent table's run always lands before its children's.
 */
export function entityRuns(rows: readonly SeedRow[]): readonly (readonly SeedRow[])[] {
  const runs: SeedRow[][] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0]?.entity === row.entity) last.push(row);
    else runs.push([row]);
  }
  return runs;
}

/** Writes the plan in order: every insert, then every deferred key. Sequential, so it replays. */
export async function insertSeedGraph(graph: SeedGraph, writer: SeedWriter): Promise<void> {
  const { insertMany } = writer;
  if (insertMany === undefined) for (const row of graph.inserts) await writer.insert(row);
  else for (const run of entityRuns(graph.inserts)) await insertMany.call(writer, run);
  for (const update of graph.updates) await writer.update(update);
}
