// The one refusal the scheduled work owns. The demo reset DELETES content, so it must be able to
// tell the embedded demo store from a real database — an hourly job that wipes a production table
// because someone set DATABASE_URL is not a bug you get to find twice.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const TASKS_ERROR_CODES = {
  X_DEMO_RESET_UNSAFE: { title: 'the demo reset refused to run against a real database' },
} as const;

registerErrorCodes(TASKS_ERROR_CODES);

export interface DemoResetUnsafeInit {
  /** The binding that proved this is not the embedded store. Never the value — it is a secret. */
  readonly boundTo: string;
}

export class DemoResetUnsafeError extends UltimateError {
  constructor(init: DemoResetUnsafeInit) {
    super({
      code: 'X_DEMO_RESET_UNSAFE',
      cause: `${init.boundTo} is set, so this process is bound to a real database — and resetDemo deletes every post, comment, upload, message and notification before re-seeding`,
      fix: `unset ${init.boundTo}   # the reset only runs against the embedded demo store; to retire it instead, delete hourlyDemoReset from apps/web/app/tasks/schedule.ts`,
      meta: { boundTo: init.boundTo },
    });
  }
}
