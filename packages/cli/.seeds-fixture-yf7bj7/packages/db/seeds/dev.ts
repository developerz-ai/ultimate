import { defineSeed, entity, integer, money, text, uuid } from '@ultimat3/entity';
const plans = entity('plan', {
  table: 'plans',
  columns: { id: uuid().primaryKey(), code: text(), seats: integer(), monthly: money() },
});
export const dev = defineSeed('dev', async ({ insert, id }) => {
  throw new TypeError('boom'); await insert(plans, [{ id: id('plan:team'), code: 'team', seats: 5, monthly: { minor: 1, currency: 'USD' } }]);
});
