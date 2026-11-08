import { test } from 'bun:test';
import { pgliteClient, postgresClient, raw, withReadTransaction } from '@ultimat3/db';
const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).filter(([k]) => /Node Type|Relation|Alias|Cond|Filter|Sort Key|Plans|Index Name|Strategy|Group Key|Plan$/.test(k)).map(([k, x]) => [k, strip(x)])) : v;
test('probe', async () => {
  const url = Bun.env['PROBE_URL']; const c = url ? postgresClient({ url }) : pgliteClient();
  if (url) for (const t of ['u','t','w']) await c.execute(raw(`drop table if exists ${t} cascade`));
  for (const s of [
    'create table t (id uuid primary key, org_id uuid not null, a int, b int, name text)',
    'create index t_org on t (org_id)', 'create index t_a on t (a)', 'create index t_b on t (b)',
    'create table u (id uuid primary key, t_id uuid not null, b int)',
    'create index u_t on u (t_id)',
    'create table w (id uuid primary key, x int, y int)',
  ]) await c.execute(raw(s));
  for (const s of [
    'select id from t where a = $1 or b = $2',
    'select id from w where x = $1 or y = $2',
    'with r as (select id, a + 1 as k from t where org_id = $1) select id from r order by k limit 10',
    'select id from (select id, a from t where org_id = $1 union all select id, b from u) s order by a limit 10',
    'select t.id from t join u on u.t_id = t.id where t.org_id = $1 order by t.a, u.b limit 10',
  ]) {
  for (const bitmap of ['off', 'on']) {
  const rows = await withReadTransaction(async (tx) => {
    await tx.execute(raw(`prepare p as ${s}`));
    const n = Math.max(0, ...[...s.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    const r = await tx.query<Record<string, unknown>>(raw(`explain (format json) execute p(${Array(n).fill('null').join(',')})`));
    await tx.execute(raw('deallocate p'));
    return r;
  }, { settings: { enable_seqscan: 'off', enable_bitmapscan: bitmap, enable_sort: 'off', plan_cache_mode: 'force_generic_plan' }, client: c });
  console.log('====', bitmap, s); console.log(JSON.stringify(strip(rows[0]?.['QUERY PLAN'])));
  }}
  await c.close();
});
