// Which port `x dev` binds: `--port`, else `PORT` from the environment, else 3000. The flag used to
// declare `default: '3000'`, and a default is indistinguishable from a caller's value — so the
// scaffold's own `.env.development` `PORT=` was read by nothing and every app booted on 3000.

import { PORT_RANGE, readIntFlag } from './flag-number';
import type { ParsedArgs } from './parse';
import { portFromEnv } from './serve';

export const DEFAULT_DEV_PORT = 3000;

/** The `metricsPortFor` shape: an explicit value, then the env, then the constant. */
export const devPortFor = (
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>>,
): number =>
  readIntFlag(args, {
    name: 'port',
    command: 'dev',
    ...PORT_RANGE,
    example: `x dev --port ${DEFAULT_DEV_PORT}`,
  }) ?? portFromEnv(env);
