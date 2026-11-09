// Single responsibility: arming failure capture for a booted role. `failureCapture.enabled` in
// `app.config.ts` installs the `failureStore` port — `runtime.ts`'s, else the Postgres bundle store
// (`x_failures`, applied by the boot's framework schema); `x dev` arms it whatever the file says.
// Off, nothing is installed and `invoke` runs bare.

import type { AppConfig } from '@ultimat3/core';
import { FAILURE_CAPTURE_DEFAULTS, settleFailureCaptures } from '@ultimat3/core';
import { type FailureStore, installFailureStore } from '@ultimat3/core/adapter';
import { postgresFailureStore } from '@ultimat3/db';

export interface ArmFailureCaptureOptions {
  /** `x dev`: on whatever `app.config.ts` says — a development process's input is the developer's. */
  readonly force?: boolean | undefined;
  /** `runtime.ts`'s `failureStore`. Omitted, the Postgres store over the boot's pool. */
  readonly store?: FailureStore | undefined;
}

/** Install the store when capture is on; answer the undo, which settles in-flight saves first. */
export function armFailureCapture(
  config: AppConfig | undefined,
  options: ArmFailureCaptureOptions = {},
): () => Promise<void> {
  const block = config?.failureCapture ?? FAILURE_CAPTURE_DEFAULTS;
  if (!block.enabled && options.force !== true) return async () => undefined;
  const release = installFailureStore(options.store ?? postgresFailureStore(), {
    perHour: block.perHour,
    maxRows: block.maxRows,
    maxBytes: block.maxBytes,
  });
  return async () => {
    await settleFailureCaptures();
    release();
  };
}
