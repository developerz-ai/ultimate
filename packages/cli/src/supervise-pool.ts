// The container's database pool — `DATABASE_POOL_MAX`, else the role's profile — which the
// supervisor splits across its children (`childShare`) and the count never exceeds.

import type { Role } from '@ultimat3/core';
import { POOL_PROFILES, poolMaxFromEnv } from '@ultimat3/db';
import type { ServeOptions } from './serve-types';

/** The container's pool: `DATABASE_POOL_MAX`, else the role's profile — what the children split. */
export const containerPool = (options: ServeOptions, role: Role): number =>
  poolMaxFromEnv(options.env).max ?? POOL_PROFILES[role].max;
