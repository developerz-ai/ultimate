// A seed is the fixture graph, written once and replayed anywhere. `id('post:tenancy')` is a
// UUID v5 of the label, so the same row gets the same id on every machine and a bug reproduced
// locally reproduces in CI. Rows go through `entity.$parse` and the invariants, which makes a
// seed a test of the schema as well as data for one.

import { createHash } from 'node:crypto';
import type { Driver } from './database';
import { memoryDriver } from './database';
import type { EntityCore } from './entity';
import type { ColumnMap, Insertable } from './types';

/** Framework namespace for seed labels. Fixed forever: changing it moves every seeded id. */
const NAMESPACE = 'a3c1f0d6-5c2b-4a3e-9f1b-6d4e7c8a9b02';

const bytesOf = (uuid: string): Uint8Array =>
  Uint8Array.from((uuid.replaceAll('-', '').match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** RFC 4122 v5: SHA-1 of namespace + name, with the version and variant bits pinned. */
export const seedId = (label: string): string => {
  const name = new TextEncoder().encode(label);
  const input = new Uint8Array(16 + name.length);
  input.set(bytesOf(NAMESPACE));
  input.set(name, 16);
  const digest = new Uint8Array(createHash('sha1').update(input).digest());
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

export interface SeedContext {
  insert<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    rows: readonly Insertable<C>[],
  ): Promise<void>;
  /** Deterministic id for a label. Same label, same uuid, every run. */
  id(label: string): string;
}

export interface SeedOptions {
  /** Defaults to a fresh in-memory driver, so a seed runs with no database at all. */
  readonly driver?: Driver;
}

export interface Seed {
  readonly name: string;
  run(options?: SeedOptions): Promise<void>;
}

export const defineSeed = (name: string, build: (context: SeedContext) => Promise<void>): Seed => ({
  name,
  run: async (options = {}) => {
    const driver = options.driver ?? memoryDriver();
    await build({
      insert: async (entity, rows) => {
        const repo = driver.repo(entity);
        for (const row of rows) await repo.insert(entity.$parse(row));
      },
      id: seedId,
    });
  },
});
