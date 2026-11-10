// A literal in `defaults` keeps its literal type against the entity's column: `status: 'open'` for
// an `enumerated(['open', 'closed'])` column compiles with no `as const`, and `'nope'` still does not.
// The proof is the test typecheck (`bun run scripts/test-typecheck-gate.ts`); the bodies also run.

import { describe, expect, expectTypeOf, test } from 'bun:test';
import { entity, enumerated, integer, text, uuid } from '@ultimat3/entity';
import { defineFactory } from './factories';
import { testName } from './test-types';

const tickets = entity('ff_lit_tickets', {
  columns: {
    id: uuid().primaryKey(),
    title: text(),
    status: enumerated(['open', 'closed']),
    priority: integer().default(0),
  },
});

describe(testName('unit', 'defaults keep their literals'), () => {
  test('an enum literal in defaults compiles with no `as const`', () => {
    const ticketFactory = defineFactory(tickets, {
      defaults: (n, ids) => ({ id: ids.uuid(), title: `t${n}`, status: 'open' }),
      traits: { closed: { status: 'closed' }, reopened: (n) => ({ status: 'open', priority: n }) },
    });
    const built = ticketFactory.build();
    expectTypeOf(built.status).toEqualTypeOf<'open' | 'closed'>();
    expect(built.status).toBe('open');
    expect(ticketFactory.with('closed').build().status).toBe('closed');
    expect(ticketFactory.with('reopened').build().status).toBe('open');
    expect(ticketFactory.build({ status: 'closed' }).status).toBe('closed');
  });

  test('a literal outside the column union still does not compile', () => {
    defineFactory(tickets, {
      // @ts-expect-error — `nope` is not one of the values `enumerated()` declares.
      defaults: (_, ids) => ({ id: ids.uuid(), title: 't', status: 'nope' }),
    });
    defineFactory(tickets, {
      defaults: (_, ids) => ({ id: ids.uuid(), title: 't', status: 'open' }),
      // @ts-expect-error — a trait is held to the same union.
      traits: { bad: { status: 'nope' } },
    });
    const ticketFactory = defineFactory(tickets, {
      defaults: (_, ids) => ({ id: ids.uuid(), title: 't', status: 'open' }),
    });
    // @ts-expect-error — and so is a call's override.
    expect(() => ticketFactory.build({ status: 'nope' })).toBeDefined();
  });
});
