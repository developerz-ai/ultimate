// The schemas every sample test walks: each `t` member, each bound, each composite. Shared so the
// minimal goldens and the seeded acceptance sweep cannot drift onto different inputs.

import type { AnySchema } from './builder';
import { t } from './t';

export const SAMPLE_FIXTURES: readonly (readonly [string, AnySchema])[] = [
  ['string', t.string],
  ['number', t.number],
  ['boolean', t.boolean],
  ['uuid', t.uuid],
  ['email', t.email],
  ['url', t.url],
  ['date', t.date],
  ['money', t.money],
  ['timezone', t.timezone],
  ['locale', t.locale],
  ['slug', t.slug],
  ['cursor', t.cursor],
  ['string.min', t.string.min(20)],
  ['string.max', t.string.max(3)],
  ['string.between', t.string.min(2).max(5)],
  ['number.min', t.number.min(7)],
  ['number.max', t.number.max(-3)],
  ['int.min', t.number.int().min(0.5)],
  ['int.max', t.number.int().max(-3.5)],
  ['int.between', t.number.int().min(1).max(100)],
  ['enum', t.enumerated('draft', 'published', 'archived')],
  ['literal', t.literal(7)],
  ['array', t.array(t.uuid)],
  ['array.bounded', t.array(t.string.max(4), { min: 2, max: 5 })],
  ['record', t.record(t.string)],
  ['union', t.union(t.uuid, t.number.int().min(0).max(9))],
  ['nullable', t.object({ cover: t.nullable(t.url) })],
  [
    'object',
    t.object({
      postId: t.uuid,
      title: t.string.min(3).max(80),
      notify: t.boolean.default(true),
      note: t.string.optional(),
      tags: t.array(t.slug, { max: 3 }),
      price: t.money,
      author: t.object({ id: t.uuid, nickname: t.nullable(t.string.max(12)) }),
    }),
  ],
  [
    'discriminated',
    t.discriminatedUnion(
      'kind',
      t.object({ kind: t.literal('a'), size: t.number.int().min(1).max(3) }),
      t.object({ kind: t.literal('b'), label: t.string.min(1) }),
    ),
  ],
];
