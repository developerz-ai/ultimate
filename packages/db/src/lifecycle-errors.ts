// Single responsibility: the refusal `entity({ retain })` raises at declaration. Here because the
// code is this package's — the drift step raises it too, for a partitioned table — and
// `@ultimat3/entity` (tier 2) reaches down for it rather than registering the same code twice.

import { renderFixShellArg } from '@ultimat3/core';
import { DbError } from './errors';

/** `retain` with no window, beside `appendOnly`, or otherwise unsweepable. */
export const retainInvalid = (entity: string, reason: string): DbError =>
  new DbError({
    code: 'X_ENTITY_RETAIN_INVALID',
    cause: `entity "${entity}" declares retain, and ${reason}`,
    fix: `x db gen "retention"   # after entity('${renderFixShellArg(entity, '<entity>')}', { retain: { after: '90d', on: 'createdAt' } }) names a window and appendOnly is gone`,
    meta: { entity },
  });
