// The refusal a hand-written `Repo` answers `series` with. It is optional on the contract so such a
// driver still compiles, which is exactly why the typed handle has to say so — as `lock` does.

import { EntityError } from './entity-error';

export const seriesUnsupported = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_SERIES_UNSUPPORTED',
    cause: `${entityName}.series() reached a repository that does not implement it: a hand-written driver, which the contract lets omit it`,
    fix: 'database(entities, { driver: postgresDriver() })   # both shipped drivers answer series; a hand-written Repo implements series(spec, args)',
  });
