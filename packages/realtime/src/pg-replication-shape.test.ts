// A replicated row is decoded by its entity's own decoder, never guessed from column names. Split
// from `pg-replication.test.ts` at its ceiling; the wire fixtures are `pg-replication-fixture.ts`.
import { describe, expect, test } from 'bun:test';
import { entity, entityForTable, text } from '@ultimat3/entity';
import { begin, commit, insert, POSTS_OID, relation, start, xlog } from './pg-replication-fixture';

// The row was GUESSED from column names: any `<p>_minor`/`<p>_currency` pair folded into a `Money`
// and every column camelCased by string rules. The entity's own decoder decides now.
describe('a replicated row is shaped by its entity, never by its column names', () => {
  test('two plain columns that merely look like money stay two plain columns', async () => {
    if (entityForTable('gauges') === undefined) {
      entity('gauges', {
        columns: { id: text().primaryKey(), sizeMinor: text(), sizeCurrency: text() },
      });
    }
    const { server, events, settled, feed } = await start({ entities: ['gauges'] });
    server.push(
      xlog(
        relation(POSTS_OID, 'gauges', [
          { name: 'id', key: true },
          { name: 'size_minor' },
          { name: 'size_currency' },
        ]),
      ),
    );
    server.push(xlog(begin(0xc000n, 0n, 30)));
    server.push(xlog(insert(POSTS_OID, ['g1', 'small', 'EUR'])));
    server.push(xlog(commit(0xc000n, 0xc100n, 0n)));
    await settled(1);
    expect(events[0]?.after).toEqual({ id: 'g1', sizeMinor: 'small', sizeCurrency: 'EUR' });
    await feed.stop();
  });
});
