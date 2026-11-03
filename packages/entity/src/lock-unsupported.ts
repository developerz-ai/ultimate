// The refusal a hand-written `Repo` answers `lock` and `lockKey` with. They are optional on the
// contract so such a driver still compiles, which is exactly why the typed handle has to say so.

import { EntityError } from './entity-error';

export const lockUnsupported = (entityName: string, method: 'lock' | 'lockKey'): EntityError =>
  new EntityError({
    code: 'X_LOCK_UNSUPPORTED',
    cause: `${entityName}.${method}() reached a repository that does not implement it: a hand-written driver, which the contract lets omit both`,
    fix: 'database(entities, { driver: postgresDriver() })   # the shipped driver has both; a hand-written Repo implements lock and lockKey',
  });
