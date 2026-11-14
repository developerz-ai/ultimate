import { defineAuth, postgresAuthAdapter, register } from '@ultimat3/auth';
import { db, sql } from '@ultimat3/db';
import { defineSeed, entity, integer, money, text, uuid } from '@ultimat3/entity';
const plans = entity('plan', {
  table: 'plans',
  columns: { id: uuid().primaryKey(), code: text(), seats: integer(), monthly: money() },
});
export const dev = defineSeed('dev', async ({ insert, id }) => {
  await insert(plans, [{ id: id('plan:team'), code: 'team', seats: 5, monthly: { minor: 19.99, currency: 'USD' } }]);
  await register(defineAuth({ adapter: postgresAuthAdapter() }), { email: 'ada@example.com', password: 'correct horse battery staple 42' });
  await db().execute(sql`insert into notes (body) values (${'seeded'})`);
  const row = await db().one(sql`select count(*)::int as n from plans`);
  if (row?.n !== 1) throw new TypeError('the entity rows went to another store');
});
