// Single responsibility: the one reader of `S3_FORCE_PATH_STYLE`. A gateway addressed by host and port
// needs path style and R2 and AWS do not, so it is declared, never sniffed from the endpoint. It read
// only `'1'`, so `true` silently selected virtual-host style and every request missed the bucket.

import { ConfigInvalidError, renderCauseValue } from '@ultimat3/core';
import type { Env } from './runtime-bindings';

/** `1` is on; `0`, unset and blank are off, as a blank `S3_*` is unset everywhere else on the disk. */
export function s3PathStyleOf(env: Env): boolean {
  const value = env['S3_FORCE_PATH_STYLE'];
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new ConfigInvalidError({
    cause: `S3_FORCE_PATH_STYLE is ${renderCauseValue(value)}, and only 0 and 1 say which addressing the disk uses`,
    fix: 'S3_FORCE_PATH_STYLE=1   # a gateway addressed by host and port; 0 for AWS and R2',
  });
}
