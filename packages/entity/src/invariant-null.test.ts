// A rule over a NULLABLE column decides a NULL the way its CHECK does: unknown, so the row passes.
// One corpus, judged twice — by `holds` in the app and by the migration's CHECK on PGlite — and the
// two verdicts must be the same for every row: NULL in each column alone, then a value each refuses.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateMigration, pgliteClient, raw, sql, sqlState, statementsOf } from '@ultimat3/db';
import { boolean, integer, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { iff } from './expr';
import { invariant } from './invariants';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const AT = '2026-11-10T00:00:00.000Z';

const probes = entity('null_parity_probes', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 40 }).nullable(),
    title: text({ max: 40 }).nullable(),
    n: integer().nullable(),
    flag: boolean().nullable(),
    code: text({ max: 40 }).nullable(),
    label: text({ max: 40 }).nullable(),
    mark: timestamp().nullable(),
    other: text({ max: 40 }).nullable(),
  },
  invariants: (c) => [
    invariant('slug_shape', c.slug.matches(/^[a-z]+$/)),
    invariant('title_length', c.title.trimmed().minLength(2)),
    invariant('n_positive', c.n.atLeast(0)),
    invariant('flag_set', c.flag.isTrue()),
    invariant('code_ok', c.code.eq('ok')),
    invariant('label_marked', iff(c.label.eq('on'), c.mark.isNotNull())),
    invariant('other_is_slug', c.other.eq(c.slug)),
  ],
});

interface Probe {
  readonly slug: string | null;
  readonly title: string | null;
  readonly n: number | null;
  readonly flag: boolean | null;
  readonly code: string | null;
  readonly label: string | null;
  readonly mark: string | null;
  readonly other: string | null;
}

const BASE: Probe = {
  slug: 'abc',
  title: 'ab',
  n: 1,
  flag: true,
  code: 'ok',
  label: 'on',
  mark: AT,
  other: 'abc',
};

const CORPUS: readonly (readonly [string, Probe])[] = [
  ['every rule satisfied', BASE],
  ...(Object.keys(BASE) as (keyof Probe)[]).map(
    (key) => [`${key} NULL`, { ...BASE, [key]: null }] as const,
  ),
  ['slug off its pattern', { ...BASE, slug: 'ABC', other: 'ABC' }],
  ['title too short', { ...BASE, title: ' a ' }],
  ['n negative', { ...BASE, n: -1 }],
  ['flag false', { ...BASE, flag: false }],
  ['code not ok', { ...BASE, code: 'no' }],
  ['label on, no mark', { ...BASE, mark: null, label: 'on' }],
  ['label off, a mark', { ...BASE, label: 'off' }],
  ['other is not slug', { ...BASE, other: 'abd' }],
];

const client = pgliteClient();

beforeAll(async () => {
  const migration = generateMigration({
    entities: [probes.$describe()],
    name: 'null parity',
    now: new Date(AT),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

afterAll(() => {
  clearRegistry();
});

const stored = (p: Probe): Promise<boolean> =>
  client
    .execute(
      sql`insert into "null_parity_probes" (id, slug, title, n, flag, code, label, mark, other) values (gen_random_uuid(), ${p.slug}, ${p.title}, ${p.n}, ${p.flag}, ${p.code}, ${p.label}, ${p.mark}::timestamptz, ${p.other})`,
    )
    .then(
      () => true,
      (error: unknown) => (sqlState(error) === '23514' ? false : Promise.reject(error)),
    );

const accepted = (p: Probe): boolean =>
  probes.$invariants.every((rule) =>
    rule.holds({ id: 'x', ...p, mark: p.mark === null ? null : new Date(p.mark) }),
  );

describe('invariants over a nullable column · the app agrees with the CHECK', () => {
  test('every row: NULL passes both halves, a value the rule refuses is refused by both', async () => {
    const verdicts: (readonly [string, boolean, boolean])[] = [];
    for (const [label, probe] of CORPUS) {
      verdicts.push([label, accepted(probe), await stored(probe)]);
    }
    expect(verdicts.filter(([, app, check]) => app !== check)).toEqual([]);
    // Not vacuous: the NULL rows pass, the value rows are refused — and `mark` NULL is refused by
    // both, because `is not null` is total: `label` on with no mark is a decided false.
    expect(verdicts.filter(([, app]) => app).map(([label]) => label)).toEqual([
      'every rule satisfied',
      ...Object.keys(BASE)
        .filter((key) => key !== 'mark')
        .map((key) => `${key} NULL`),
    ]);
  });

  test('isNull / isNotNull stay total: a NULL is decided, never unknown', () => {
    const [marked] = probes.$invariants.filter((rule) => rule.name === 'label_marked');
    // `label` on, `mark` NULL: `on = on` is true and `mark is not null` is false — refused.
    expect(marked?.holds({ id: 'x', ...BASE, mark: null })).toBe(false);
  });
});
